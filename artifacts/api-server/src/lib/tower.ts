/**
 * Optional Tower registry cross-check for Arc token identities.
 *
 * Revo never routes or executes through Tower. Its public API is consulted only
 * as an optional second opinion on the pinned USDC and EURC addresses.
 *
 * Tower's amount encoding is not base units: it scales a human amount by
 * 10^(18 - decimals), while executable ERC-20 amounts use 10^decimals. Its
 * quote API can also report success with zero output and a zero minimum. These
 * hazards are why no Tower quote or amount is ever used for execution.
 */

const TOWER_BASE_URL = "https://www.tower.exchange/api/public";

/** Arc mainnet. */
export const TOWER_CHAIN_ID = 5042;

const REQUEST_TIMEOUT_MS = 15_000;
const REGISTRY_TTL_MS = 5 * 60_000;
const REGISTRY_FAILURE_TTL_MS = 15_000;

/**
 * Token identities live in `arc-tokens`. Re-exported here so existing callers
 * keep working.
 */
export {
  ARC_TRADED_TOKENS,
  ARC_TOKENS,
  isTradedSymbol,
  type ArcToken,
  type TradedSymbol,
} from "./arc-tokens";

import { ARC_TRADED_TOKENS, isTradedSymbol } from "./arc-tokens";

/** True when a Tower API key is configured. Never reveals the key itself. */
export function isTowerConfigured(): boolean {
  return Boolean(process.env["TOWER_API_KEY"]);
}

// ---------------------------------------------------------------------------
// Amount conversion
// ---------------------------------------------------------------------------

/** Longest caller-supplied amount string accepted, digits and point included. */
const MAX_AMOUNT_CHARS = 30;

function isValidDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 18;
}

/**
 * Convert a human decimal string into real base units.
 *
 * This is the only amount conversion whose output may ever reach a signer.
 * It is deliberately independent of anything Tower reports.
 */
export function toBaseUnits(human: string, decimals: number): bigint | null {
  if (!isValidDecimals(decimals)) return null;
  const trimmed = human.trim();
  // A caller-supplied amount is untrusted input. Bounding its length keeps an
  // absurd figure from reaching BigInt or silently losing precision in a later
  // Number() comparison.
  if (trimmed.length === 0 || trimmed.length > MAX_AMOUNT_CHARS) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > decimals) return null;
  const padded = fracPart.padEnd(decimals, "0");
  return BigInt(wholePart + (decimals > 0 ? padded : ""));
}

/** Render base units back into a human decimal string. */
export function fromBaseUnits(value: bigint, decimals: number): string {
  if (!isValidDecimals(decimals) || decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

class TowerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TowerError";
  }
}

/**
 * Scrub credentials out of a message before it is shown to an operator or
 * written to a log.
 *
 * Tower's error bodies are passed through because they carry the only useful
 * diagnosis ("No valid route found", "Unsupported or invalid inputToken"). An
 * upstream that reflected the Authorization header back would otherwise turn
 * that courtesy into a key disclosure, so the live key is removed by value and
 * any bearer-shaped token by shape, and the result is length-capped.
 */
function redact(message: unknown): string {
  if (typeof message !== "string" || message.length === 0) return "Tower returned an unreadable error";
  const key = process.env["TOWER_API_KEY"];
  let safe = message;
  if (key && key.length >= 8) safe = safe.split(key).join("[redacted]");
  safe = safe.replace(/\b(bearer|authorization|api[-_ ]?key)\b\s*[:=]?\s*\S+/gi, "$1 [redacted]");
  return safe.length > 300 ? `${safe.slice(0, 300)}...` : safe;
}

/**
 * Issue an authenticated Tower request.
 *
 * The API key is read at call time and attached to the header only. It is
 * never placed in a URL, a log line, or an error message, so a thrown
 * TowerError is always safe to surface.
 */
async function towerFetch<T>(
  path: string,
  init?: { method: "POST"; body: unknown },
): Promise<T> {
  const key = process.env["TOWER_API_KEY"];
  if (!key) throw new TowerError("Tower API key is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${TOWER_BASE_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        authorization: `Bearer ${key}`,
        ...(init ? { "content-type": "application/json" } : {}),
      },
      ...(init ? { body: JSON.stringify(init.body) } : {}),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TowerError(`Tower returned a non-JSON response (HTTP ${response.status})`);
    }

    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : `HTTP ${response.status}`;
      throw new TowerError(redact(message));
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof TowerError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new TowerError("Tower did not respond in time");
    }
    throw new TowerError("Tower is unreachable");
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

interface TowerChain {
  numericId: number | null;
  supportedFeatures: string[];
}

/**
 * HTTP 200 is not agreement. Tower can answer successfully with
 * `success: false` or a malformed body, and a registry trusted while malformed
 * is exactly what would let an unverified token slip past the address pinning
 * in `checkPairSupport`. Every entry is therefore shape-checked before it is
 * allowed to influence a trading decision.
 */
function successData(payload: unknown): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const { success, data } = payload as { success?: unknown; data?: unknown };
  if (success !== true || !Array.isArray(data)) return null;
  return data;
}

function isTowerChain(value: unknown): value is TowerChain {
  if (!value || typeof value !== "object") return false;
  const chain = value as Record<string, unknown>;
  const features = chain["supportedFeatures"];
  return (
    (typeof chain["numericId"] === "number" || chain["numericId"] === null) &&
    Array.isArray(features) &&
    features.every((feature) => typeof feature === "string")
  );
}

function isTowerToken(value: unknown): value is TowerToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Record<string, unknown>;
  return (
    typeof token["symbol"] === "string" &&
    typeof token["address"] === "string" &&
    typeof token["decimals"] === "number" &&
    Number.isInteger(token["decimals"]) &&
    typeof token["chainId"] === "number"
  );
}

interface TowerToken {
  symbol: string;
  address: string;
  decimals: number;
  chainId: number;
}

export interface TowerRegistry {
  available: boolean;
  arcSupportsSwaps: boolean;
  tokens: TowerToken[];
  error?: string;
  checkedAt: string;
}

let registryCache: { value: TowerRegistry; expiresAt: number } | null = null;
let registryInFlight: Promise<TowerRegistry> | null = null;

async function loadRegistry(): Promise<TowerRegistry> {
  const checkedAt = new Date().toISOString();
  try {
    const [chains, tokens] = await Promise.all([
      towerFetch<unknown>("/chains"),
      towerFetch<unknown>("/tokens"),
    ]);

    const chainList = successData(chains);
    const tokenList = successData(tokens);
    if (!chainList) throw new TowerError("Tower returned an unusable chain list");
    if (!tokenList) throw new TowerError("Tower returned an unusable token list");

    const arc = chainList.filter(isTowerChain).find((c) => c.numericId === TOWER_CHAIN_ID);
    return {
      available: true,
      arcSupportsSwaps: Boolean(arc?.supportedFeatures.includes("swaps")),
      tokens: tokenList.filter(isTowerToken),
      checkedAt,
    };
  } catch (error) {
    return {
      available: false,
      arcSupportsSwaps: false,
      tokens: [],
      error: error instanceof Error ? error.message : "Tower registry could not be read",
      checkedAt,
    };
  }
}

/** Tower's chain and token registry, cached briefly and coalesced. */
export async function getTowerRegistry(): Promise<TowerRegistry> {
  const now = Date.now();
  if (registryCache && registryCache.expiresAt > now) return registryCache.value;
  if (registryInFlight) return registryInFlight;

  registryInFlight = loadRegistry()
    .then((value) => {
      registryCache = {
        value,
        expiresAt: Date.now() + (value.available ? REGISTRY_TTL_MS : REGISTRY_FAILURE_TTL_MS),
      };
      return value;
    })
    .finally(() => {
      registryInFlight = null;
    });
  return registryInFlight;
}

/** Test seam. Clears the registry cache. */
export function resetTowerRegistryCache(): void {
  registryCache = null;
  registryInFlight = null;
}

// ---------------------------------------------------------------------------
// Pair support
// ---------------------------------------------------------------------------

export interface PairSupport {
  inputSymbol: string;
  outputSymbol: string;
  supported: boolean;
  /** Present whenever `supported` is false. Always states the actual cause. */
  reason?: string;
  registryAvailable: boolean;
  arcSupportsSwaps: boolean;
  checkedAt: string;
}

/**
 * Cross-check a pair against Tower's registry. Address drift against the
 * pinned identities is treated as a hard stop.
 */
export async function checkPairSupport(
  inputSymbol: string,
  outputSymbol: string,
): Promise<PairSupport> {
  const checkedAt = new Date().toISOString();
  const base = {
    inputSymbol,
    outputSymbol,
    registryAvailable: false,
    arcSupportsSwaps: false,
    checkedAt,
  };

  if (!isTowerConfigured()) {
    return { ...base, supported: false, reason: "Tower API key is not configured" };
  }
  if (inputSymbol === outputSymbol) {
    return { ...base, supported: false, reason: "Input and output tokens are the same" };
  }
  for (const symbol of [inputSymbol, outputSymbol]) {
    if (!isTradedSymbol(symbol)) {
      return {
        ...base,
        supported: false,
        reason: `${symbol} is not an approved Revo trading token on Arc`,
      };
    }
  }

  const registry = await getTowerRegistry();
  const withRegistry = {
    ...base,
    registryAvailable: registry.available,
    arcSupportsSwaps: registry.arcSupportsSwaps,
  };
  if (!registry.available) {
    return { ...withRegistry, supported: false, reason: registry.error ?? "Tower registry unavailable" };
  }
  if (!registry.arcSupportsSwaps) {
    return { ...withRegistry, supported: false, reason: "Tower no longer reports swap support on Arc" };
  }

  for (const symbol of [inputSymbol, outputSymbol]) {
    const pinned = ARC_TRADED_TOKENS[symbol]!;
    const listed = registry.tokens.find(
      (t) => t.chainId === TOWER_CHAIN_ID && t.symbol === symbol,
    );
    if (!listed) {
      return {
        ...withRegistry,
        supported: false,
        reason: `Tower no longer lists ${symbol} on Arc`,
      };
    }
    if (listed.address.toLowerCase() !== pinned.address.toLowerCase()) {
      return {
        ...withRegistry,
        supported: false,
        reason: `Tower reports a different contract address for ${symbol} than Revo has pinned`,
      };
    }
    if (listed.decimals !== pinned.decimals) {
      return {
        ...withRegistry,
        supported: false,
        reason: `Tower reports ${listed.decimals} decimals for ${symbol}, Revo has pinned ${pinned.decimals}`,
      };
    }
  }

  return { ...withRegistry, supported: true };
}
