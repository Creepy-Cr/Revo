/**
 * X (Twitter) social-sentiment source for the alpha signals.
 *
 * DORMANT BY DEFAULT: this module only activates when the X_API_BEARER_TOKEN
 * secret is present. Without it, fetchXSentiment() returns null immediately,
 * the sentiment component is omitted from the composite signals, and the
 * remaining source weights renormalize - exactly the same "never fabricate"
 * pattern used for CoinGecko and GitHub outages.
 *
 * Availability policy: when X is unavailable (error / cooldown / no token),
 * the component is OMITTED - never served stale, never fabricated.
 *
 * Cost controls (X charges per tweet read, ~$0.005/post):
 *  - max_results=25 per asset per refresh (2 assets = 50 reads/refresh)
 *  - 12h success cache  -> 2 refreshes/day -> ~100 reads/day (~$15/month)
 *  - per-asset single-flight dedup: concurrent callers share one request,
 *    so a cache expiry or cold start can never fan out into paid reads
 *  - 30min failure cooldown so errors never trigger retry storms
 */

import { scoreTexts } from "./sentiment-lexicon";

const X_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
const SUCCESS_TTL_MS = 12 * 60 * 60_000; // 12 hours
const FAILURE_COOLDOWN_MS = 30 * 60_000; // 30 minutes
const MAX_RESULTS = 25; // per asset per refresh

export type XSentimentAsset = "ETH" | "USDC";

export interface XSentiment {
  asset: XSentimentAsset;
  /** Signed sentiment: -100 (bearish) .. +100 (bullish). */
  score: number;
  sampleSize: number;
  bullish: number;
  bearish: number;
  neutral: number;
  fetchedAt: number;
}

const QUERIES: Record<XSentimentAsset, string> = {
  ETH: '(ethereum OR $eth) lang:en -is:retweet -is:reply',
  USDC: '(usdc OR "usd coin") lang:en -is:retweet -is:reply',
};

/** Defensively extract post texts from an X v2 recent-search payload. */
function extractTexts(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const texts: string[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const text = (item as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

interface CacheEntry {
  sentiment: XSentiment | null;
  fetchedAt: number;
}

const cache = new Map<XSentimentAsset, CacheEntry>();
const inFlight = new Map<XSentimentAsset, Promise<XSentiment | null>>();
const failureCooldownUntil = new Map<XSentimentAsset, number>();

export function xSentimentEnabled(): boolean {
  return Boolean(process.env.X_API_BEARER_TOKEN);
}

async function refreshSentiment(
  asset: XSentimentAsset,
  token: string,
): Promise<XSentiment | null> {
  try {
    const params = new URLSearchParams({
      query: QUERIES[asset],
      max_results: String(MAX_RESULTS),
      "tweet.fields": "lang",
    });
    const res = await fetch(`${X_SEARCH_URL}?${params.toString()}`, {
      signal: AbortSignal.timeout(8_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "revo-treasury-testnet-simulator",
      },
    });
    if (!res.ok) {
      throw new Error(`X API responded ${res.status}`);
    }
    const texts = extractTexts(await res.json());
    const scored = scoreTexts(texts);
    const sentiment: XSentiment | null = scored
      ? { ...scored, asset, fetchedAt: Date.now() }
      : null;
    cache.set(asset, { sentiment, fetchedAt: Date.now() });
    failureCooldownUntil.delete(asset);
    return sentiment;
  } catch (error) {
    console.error(`X sentiment unavailable for ${asset}:`, error);
    failureCooldownUntil.set(asset, Date.now() + FAILURE_COOLDOWN_MS);
    // Unavailable source => component omitted. Never serve stale sentiment.
    return null;
  }
}

export async function fetchXSentiment(
  asset: XSentimentAsset,
): Promise<XSentiment | null> {
  const token = process.env.X_API_BEARER_TOKEN;
  if (!token) return null; // dormant until the secret is added

  const now = Date.now();
  const cached = cache.get(asset);
  if (cached && now - cached.fetchedAt < SUCCESS_TTL_MS) {
    return cached.sentiment;
  }
  if (now < (failureCooldownUntil.get(asset) ?? 0)) {
    return null; // cooling down after a failure - omit, never refetch early
  }

  // Single-flight: concurrent callers share one paid request per asset.
  const existing = inFlight.get(asset);
  if (existing) return existing;

  const request = refreshSentiment(asset, token).finally(() => {
    inFlight.delete(asset);
  });
  inFlight.set(asset, request);
  return request;
}
