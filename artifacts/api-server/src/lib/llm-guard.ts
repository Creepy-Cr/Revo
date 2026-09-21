import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Guards for LLM-backed routes. Each request to the authenticated mainnet API
 * demo, and every request to these routes spends real inference budget via
 * the project's LLM integration - so each route gets:
 *
 *  - a fixed-window per-client rate limit (keyed by proxied client IP), and
 *  - a small global concurrency cap, so a burst from many IPs cannot fan out
 *    into unbounded parallel upstream calls.
 *
 * State is in-memory and per-process, which matches the single-instance
 * deployment; the caps fail closed with 429s, never by silently dropping
 * requests.
 */

interface WindowEntry {
  count: number;
  windowStart: number;
}

const SWEEP_INTERVAL_MS = 60_000;

function clientKey(req: Request): string {
  // Behind a reverse proxy the client address is the first entry of
  // X-Forwarded-For (req.ip honors this once `trust proxy` is enabled).
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export interface LlmGuardOptions {
  /** Human-readable scope used in error messages, e.g. "agent Q&A". */
  scope: string;
  /** Fixed window size in milliseconds. */
  windowMs: number;
  /** Max requests per client per window. */
  maxPerWindow: number;
  /** Max in-flight requests across all clients. */
  maxConcurrent: number;
}

export function llmGuard(options: LlmGuardOptions): RequestHandler {
  const windows = new Map<string, WindowEntry>();
  let inFlight = 0;
  let lastSweep = Date.now();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();

    // Opportunistic cleanup so the map cannot grow without bound.
    if (now - lastSweep > SWEEP_INTERVAL_MS) {
      lastSweep = now;
      for (const [key, entry] of windows) {
        if (now - entry.windowStart >= options.windowMs) windows.delete(key);
      }
    }

    const key = clientKey(req);
    const entry = windows.get(key);
    if (!entry || now - entry.windowStart >= options.windowMs) {
      windows.set(key, { count: 1, windowStart: now });
    } else if (entry.count >= options.maxPerWindow) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((entry.windowStart + options.windowMs - now) / 1000),
      );
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: `Too many ${options.scope} requests. Try again in ${retryAfterSec}s.`,
      });
      return;
    } else {
      entry.count += 1;
    }

    if (inFlight >= options.maxConcurrent) {
      res.setHeader("Retry-After", "5");
      res.status(429).json({
        error: `The ${options.scope} channel is busy. Try again in a few seconds.`,
      });
      return;
    }

    inFlight += 1;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        inFlight -= 1;
      }
    };
    res.on("finish", release);
    res.on("close", release);

    next();
  };
}
