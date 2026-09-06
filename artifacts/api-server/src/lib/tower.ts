/**
 * Tower Exchange client - swap routing and quotes on Arc Testnet.
 *
 * Tower is the only venue in its own chain list that reports `swaps` support
 * on Arc Testnet (5042002); the other eleven chains it serves are bridge-only.
 * That makes it the one place a Revo rebalance can become a real trade rather
 * than a database entry.
 *
 * Five properties of Tower's public API are hazardous enough to be handled
 * here rather than left to callers:
 *
 * 1. Amount encoding is not base units. Tower scales a human amount by
 *    10^(18 - decimals) instead of the standard 10^decimals. Confirmed against
 *    tokens of three different precisions: 1 USDC (6dp) echoes as 1e12, 1
 *    cirBTC (8dp) as 1e10, 1 USDT (18dp) as 1. For USDC that is a million
 *    times the real base-unit figure, so forwarding a Tower amount to a signer
 *    would spend a million times the intended size. Nothing here ever hands a
 *    Tower amount onward as executable; `toBaseUnits` recomputes it from the
 *    token's own decimals.
 *
 * 2. A quote can succeed while quoting nothing. Tower returns `success: true`
 *    with `outputAmount: "0"` and `minOut: "0"` on routes with no usable
 *    depth. Signing that is a swap with no floor on what comes back, so a zero
 *    output or a zero floor is an unusable route here, never a tradable quote.
 *
 * 3. Its risk figures contradict themselves. Tower has reported
 *    `priceImpact: 0` while routing through a hop it simultaneously reports as
 *    having `liquidity: "0"`, and 30% impact on other hops in the same call.
 *    Its numbers are recorded as indicative and never form the basis of a
 *    safety decision on their own.
 *
 * 4. Testnet pools are not priced like the assets they name. cirBTC has quoted
 *    near 4,000 USDC while real BTC trades orders of magnitude higher. A quote
 *    can therefore be perfectly executable and still economically meaningless,
 *    which is why callers may pass reference prices and have the implied rate
 *    checked against them.
 *
 * 5. It cannot quote a fractional amount at all. Any input containing a
 *    decimal point crashes the endpoint with HTTP 500 and the message
 *    "Cannot convert 0.001 to a BigInt", so the whole-number restriction is
 *    stated up front here instead of reaching an operator as an opaque
 *    upstream failure.
 *
 * The consequence is that this module quotes but does not authorise. A quote
 * is route discovery plus an indicative price. Executable amounts are derived
 * independently here and still have to be confirmed on-chain before anything
 * is signed.
 */

const TOWER_BASE_URL = "https://www.tower.exchange/api/public";

/** Arc Testnet. The only chain Tower will accept a swap on. */
export const TOWER_CHAIN_ID = 5042002;

const REQUEST_TIMEOUT_MS = 15_000;
const REGISTRY_TTL_MS = 5 * 60_000;
const REGISTRY_FAILURE_TTL_MS = 15_000;

/** Routes quoting worse than this are refused rather than merely flagged. */
const MAX_PRICE_IMPACT_PCT = 5;

/**
 * How far Tower's implied rate may sit from a real-world reference before the
 * quote is refused. Testnet pools drift hard, so this is deliberately wide; it
 * exists to catch a pool that is broken, not one that is merely illiquid.
 */
const MAX_REFERENCE_DEVIATION_PCT = 25;

export interface ArcToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** How the treasury treats this leg: the stable side or the risk side. */
  role: "stable" | "risk";
}

/**
 * Token identities Revo pins for itself.
 *
 * Tower's registry is consulted at runtime but checked against these rather
 * than trusted. An address that changes underneath us is a reason to stop
 * trading, not a reason to follow it to a new contract.
 */
export const ARC_TRADED_TOKENS: Record<string, ArcToken> = {
  USDC: {
    symbol: "USDC",
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    role: "stable",
  },
  cirBTC: {
    symbol: "cirBTC",
    address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
    decimals: 8,
    role: "risk",
  },
};

export type TradedSymbol = keyof typeof ARC_TRADED_TOKENS;

export function isTradedSymbol(symbol: string): symbol is TradedSymbol {
  return Object.prototype.hasOwnProperty.call(ARC_TRADED_TOKENS, symbol);
}

/** True when a Tower API key is configured. Never reveals the key itself. */
export function isTowerConfigured(): boolean {
  return Boolean(process.env["TOWER_API_KEY"]);
}

// ---------------------------------------------------------------------------
// Amount conversion
// ---------------------------------------------------------------------------

/** Longest caller-supplied amount string accepted, digits and point included. */
const MAX_AMOUNT_CHARS = 30;

/** Longest raw upstream amount accepted before it is treated as malformed. */
const MAX_RAW_AMOUNT_CHARS = 40;

function isValidDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= 18;
}

/**
 * Parse a decimal string that must survive later arithmetic.
 *
 * Returns null for anything that is not a finite number, so a value too large
 * or malformed to compare is refused rather than silently passing a threshold
 * check as NaN or Infinity.
 */
function toFinite(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

/**
 * Decode one of Tower's amount fields into a human figure.
 *
 * Tower's scale is 10^(18 - decimals), which is not base units. This exists so
 * its indicative figures can be displayed honestly; the result is never used
 * to build a transaction.
 */
export function decodeTowerAmount(raw: unknown, decimals: number): string | null {
  if (!isValidDecimals(decimals)) return null;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RAW_AMOUNT_CHARS) return null;
  if (!/^\d+$/.test(raw)) return null;
  const exponent = 18 - decimals;
  if (exponent < 0 || exponent > 18) return null;
  if (exponent === 0) return raw.replace(/^0+(?=\d)/, "");
  const scale = 10n ** BigInt(exponent);
  const value = BigInt(raw);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(exponent, "0").replace(/0+$/, "");
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
 * Answer whether Revo may attempt this pair at all, before any quote is asked
 * for. Address drift against the pinned identities is treated as a hard stop.
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
        reason: `${symbol} is not an approved Revo trading token on Arc Testnet`,
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
    return { ...withRegistry, supported: false, reason: "Tower no longer reports swap support on Arc Testnet" };
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
        reason: `Tower no longer lists ${symbol} on Arc Testnet`,
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

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface SwapQuote {
  inputSymbol: string;
  outputSymbol: string;
  /** Human amount requested, echoed back unchanged. */
  inputAmount: string;
  /** Real base units, computed here from pinned decimals. Never Tower's figure. */
  inputBaseUnits: string;
  /** Tower's expected output, decoded to human. Indicative only. */
  indicativeOutput: string | null;
  /** Tower's own minimum-output floor, decoded to human. Indicative only. */
  indicativeMinOut: string | null;
  /** Output units per input unit implied by the quote, for sanity checking. */
  impliedRate: number | null;
  priceImpactPct: number | null;
  feeBps: number | null;
  slippageBps: number | null;
  gasEstimate: string | null;
  dexName: string | null;
  routerAddress: string | null;
  routePath: string[];
  /** False whenever the route must not be signed. `reason` then says why. */
  tradable: boolean;
  reason?: string;
  /** Non-fatal concerns worth showing an operator before they approve. */
  warnings: string[];
  quotedAt: string;
}

export interface QuoteRequest {
  inputSymbol: string;
  outputSymbol: string;
  /** Human decimal string, e.g. "12.5". */
  amount: string;
  /**
   * Optional real-world USD prices for the two tokens. When supplied, the
   * quote's implied rate is checked against them, which is the only defence
   * against a testnet pool that prices cirBTC like a mid-cap altcoin.
   */
  referenceUsd?: { input: number; output: number };
}

interface TowerQuoteHop {
  dexName?: string;
  dexRouter?: string;
  path?: string[];
  liquidity?: string;
  priceImpact?: number;
}

interface TowerQuoteData {
  outputAmount?: string;
  minOut?: string;
  priceImpact?: number;
  gasEstimate?: string;
  slippage?: number;
  feeBps?: number;
  route?: { hops?: TowerQuoteHop[] };
}

function refuse(partial: Omit<SwapQuote, "tradable" | "reason">, reason: string): SwapQuote {
  return { ...partial, tradable: false, reason };
}

/**
 * Ask Tower to price a swap.
 *
 * Always resolves. A route that cannot be traded comes back with
 * `tradable: false` and a reason rather than as a thrown error, because the
 * caller has to render the cause either way and an unusable route is an
 * ordinary outcome on a testnet, not an exception.
 */
export async function getSwapQuote(request: QuoteRequest): Promise<SwapQuote> {
  const { inputSymbol, outputSymbol, amount, referenceUsd } = request;
  const quotedAt = new Date().toISOString();
  const warnings: string[] = [];

  const skeleton: Omit<SwapQuote, "tradable" | "reason"> = {
    inputSymbol,
    outputSymbol,
    inputAmount: amount,
    inputBaseUnits: "0",
    indicativeOutput: null,
    indicativeMinOut: null,
    impliedRate: null,
    priceImpactPct: null,
    feeBps: null,
    slippageBps: null,
    gasEstimate: null,
    dexName: null,
    routerAddress: null,
    routePath: [],
    warnings,
    quotedAt,
  };

  const support = await checkPairSupport(inputSymbol, outputSymbol);
  if (!support.supported) {
    return refuse(skeleton, support.reason ?? "Pair is not supported on Arc Testnet");
  }

  const inputToken = ARC_TRADED_TOKENS[inputSymbol]!;
  const outputToken = ARC_TRADED_TOKENS[outputSymbol]!;

  const baseUnits = toBaseUnits(amount, inputToken.decimals);
  if (baseUnits === null) {
    return refuse(skeleton, `"${amount}" is not a valid ${inputSymbol} amount`);
  }
  if (baseUnits <= 0n) {
    return refuse(skeleton, "Swap amount must be greater than zero");
  }

  // Tower's quote endpoint crashes on any decimal point rather than rounding
  // or rejecting cleanly, so the restriction is enforced before the call and
  // reported as the size constraint it actually is. For an 8-decimal token
  // like cirBTC this makes one whole token the smallest quotable trade.
  if (amount.trim().includes(".")) {
    return refuse(
      skeleton,
      `Tower can only quote whole-number amounts, so ${amount} ${inputSymbol} cannot be priced. The smallest quotable trade is 1 ${inputSymbol}.`,
    );
  }

  const withUnits = { ...skeleton, inputBaseUnits: baseUnits.toString() };

  let response: { success?: boolean; error?: string; data?: TowerQuoteData };
  try {
    response = await towerFetch("/swap/quote", {
      method: "POST",
      body: {
        inputToken: inputToken.symbol,
        outputToken: outputToken.symbol,
        inputAmount: amount,
        chainId: TOWER_CHAIN_ID,
      },
    });
  } catch (error) {
    return refuse(withUnits, error instanceof Error ? error.message : "Tower quote failed");
  }

  if (!response.success || !response.data) {
    return refuse(withUnits, response.error ?? "Tower returned no route for this pair");
  }

  const data = response.data;
  const hop = data.route?.hops?.[0];
  const indicativeOutput = decodeTowerAmount(data.outputAmount, outputToken.decimals);
  const indicativeMinOut = decodeTowerAmount(data.minOut, outputToken.decimals);

  const enriched: Omit<SwapQuote, "tradable" | "reason"> = {
    ...withUnits,
    indicativeOutput,
    indicativeMinOut,
    impliedRate: null,
    priceImpactPct: typeof data.priceImpact === "number" ? data.priceImpact : null,
    feeBps: typeof data.feeBps === "number" ? data.feeBps : null,
    slippageBps: typeof data.slippage === "number" ? data.slippage : null,
    gasEstimate: typeof data.gasEstimate === "string" ? data.gasEstimate : null,
    dexName: hop?.dexName ?? null,
    routerAddress: hop?.dexRouter ?? null,
    routePath: Array.isArray(hop?.path) ? hop.path : [],
  };

  if (indicativeOutput === null) {
    return refuse(enriched, "Tower did not return a readable output amount");
  }
  const outputValue = toFinite(indicativeOutput);
  const inputValue = toFinite(amount);
  if (outputValue === null || inputValue === null || inputValue <= 0) {
    return refuse(enriched, "Tower returned amounts Revo cannot evaluate safely");
  }
  if (outputValue <= 0) {
    return refuse(
      enriched,
      "Tower found a route but quoted zero output, so this pair has no usable liquidity at this size",
    );
  }
  const minOutValue = indicativeMinOut === null ? null : toFinite(indicativeMinOut);
  if (minOutValue === null || minOutValue <= 0) {
    return refuse(
      enriched,
      "Tower quoted no minimum-output floor, which would leave the swap unbounded",
    );
  }

  const impliedRate = outputValue / inputValue;
  const priced = { ...enriched, impliedRate };

  if (!hop?.dexRouter) {
    return refuse(priced, "Tower did not name a router contract for this route");
  }
  if (hop.liquidity === "0") {
    return refuse(priced, "Tower routed through a pool it reports as having zero liquidity");
  }
  if (priced.priceImpactPct !== null && priced.priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    return refuse(
      priced,
      `Price impact of ${priced.priceImpactPct}% exceeds the ${MAX_PRICE_IMPACT_PCT}% ceiling`,
    );
  }

  // Fail closed without an independent price. Arc's pools are detached enough
  // from real markets that this comparison is the only thing separating a route
  // that merely executes from one worth executing, so skipping it with a
  // warning would wave through precisely the case it exists to catch.
  const refInput = referenceUsd?.input;
  const refOutput = referenceUsd?.output;
  if (
    typeof refInput !== "number" ||
    typeof refOutput !== "number" ||
    !Number.isFinite(refInput) ||
    !Number.isFinite(refOutput) ||
    refInput <= 0 ||
    refOutput <= 0
  ) {
    return refuse(
      priced,
      "No independent market price was available, so this pool rate could not be checked and the route must not be traded",
    );
  }

  const expectedRate = refInput / refOutput;
  const deviation = Math.abs((impliedRate - expectedRate) / expectedRate) * 100;
  if (deviation > MAX_REFERENCE_DEVIATION_PCT) {
    return refuse(
      priced,
      `Pool price is ${deviation.toFixed(0)}% away from the real ${inputSymbol}/${outputSymbol} market rate, so this quote is not economically meaningful`,
    );
  }
  if (deviation > MAX_REFERENCE_DEVIATION_PCT / 2) {
    warnings.push(`Pool price sits ${deviation.toFixed(0)}% from the real market rate`);
  }

  if (priced.priceImpactPct === null) {
    warnings.push("Tower did not report a price impact for this route");
  }
  warnings.push("Amounts are indicative; the executable figures must be confirmed on-chain before signing");

  return { ...priced, tradable: true };
}
