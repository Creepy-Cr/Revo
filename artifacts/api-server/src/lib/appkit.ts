/**
 * Circle App Kit integration.
 *
 * Revo settles on Arc, but a treasury's USDC is rarely confined to one chain.
 * App Kit answers the cross-chain half of that picture. This module currently
 * exposes a single read: the treasury custody wallet's Circle Gateway unified
 * USDC balance across every supported testnet.
 *
 * Two properties of this reading are easy to get wrong, so they are enforced
 * here rather than left to callers:
 *
 * 1. A Gateway balance is NOT a wallet balance. Gateway is a deposit contract -
 *    USDC appears in this reading only after it has been deposited into
 *    Gateway. Zero means "nothing deposited into Gateway", never "the treasury
 *    is empty". The `deposited` flag exists so the console cannot quietly
 *    render the first as the second.
 * 2. Failures are surfaced, not fabricated. Following lib/chain.ts, successes
 *    and failures are both cached, concurrent callers are coalesced, and a
 *    failed refresh serves the last good reading marked stale rather than
 *    inventing zeros. A malformed or partial upstream response counts as a
 *    failure: we never substitute a default for a figure Gateway did not send,
 *    because a fabricated zero is indistinguishable from a real one.
 */
import { AppKit } from "@circle-fin/app-kit";

/** App Kit's identifier for Arc Testnet, Revo's settlement chain. */
const ARC_CHAIN = "Arc_Testnet";

const SUCCESS_TTL_MS = 30_000;
const FAILURE_TTL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 12_000;

/**
 * The cache is keyed by custody address, so it grows with tenant count rather
 * than with traffic. Both bounds exist to keep that growth from becoming a
 * slow leak in a long-lived process.
 */
const MAX_CACHED_ADDRESSES = 256;
const IDLE_EVICTION_MS = 10 * 60_000;

export interface CrosschainChainBalance {
  chain: string;
  label: string;
  confirmedBalance: string;
  isArc: boolean;
}

export interface CrosschainBalanceReading {
  address: string;
  token: "USDC";
  source: "circle-gateway";
  available: boolean;
  deposited: boolean;
  /** Always present when `available` is true; absent means we have no figure. */
  totalConfirmed?: string;
  chains: CrosschainChainBalance[];
  stale: boolean;
  checkedAt: string;
  error?: string;
}

let kit: AppKit | null = null;

/** Gateway reads need no credentials, so construction is lazy and unconditional. */
function appKit(): AppKit {
  kit ??= new AppKit();
  return kit;
}

interface CacheEntry {
  lastGood: CrosschainBalanceReading | null;
  lastResult: CrosschainBalanceReading | null;
  lastProbeAt: number;
  inFlight: Promise<CrosschainBalanceReading> | null;
}

/** One cache entry per custody wallet; treasuries must not read each other's figures. */
const cache = new Map<string, CacheEntry>();

/**
 * Runs only once the cache reaches its cap, so the common request path stays
 * O(1). Entries with a request in flight are never evicted - dropping one would
 * uncouple a waiting caller from the result it is about to receive.
 */
function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.inFlight) continue;
    if (now - entry.lastProbeAt > IDLE_EVICTION_MS) cache.delete(key);
  }
  if (cache.size < MAX_CACHED_ADDRESSES) return;

  const evictable = [...cache.entries()]
    .filter(([, entry]) => !entry.inFlight)
    .sort((a, b) => a[1].lastProbeAt - b[1].lastProbeAt);
  for (const [key] of evictable) {
    if (cache.size < MAX_CACHED_ADDRESSES) break;
    cache.delete(key);
  }
}

function entryFor(address: string): CacheEntry {
  const key = address.toLowerCase();
  const existing = cache.get(key);
  if (existing) return existing;

  if (cache.size >= MAX_CACHED_ADDRESSES) pruneCache(Date.now());
  const entry: CacheEntry = { lastGood: null, lastResult: null, lastProbeAt: 0, inFlight: null };
  cache.set(key, entry);
  return entry;
}

function labelFor(chain: string): string {
  return chain.replace(/_/g, " ");
}

/** Gateway returns decimal strings; we only ever ask "is there anything here". */
function isPositive(amount: string): boolean {
  const value = Number(amount);
  return Number.isFinite(value) && value > 0;
}

const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;

/**
 * Upstream figures are validated, never coerced. A missing or non-decimal
 * amount fails the probe so the caller reports "unavailable" instead of a
 * number Gateway never sent.
 */
function requireDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL_AMOUNT.test(value)) {
    throw new Error(`Circle Gateway returned a malformed ${field}`);
  }
  return value;
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Circle Gateway did not respond within ${REQUEST_TIMEOUT_MS}ms`));
    }, REQUEST_TIMEOUT_MS);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Shape of the Gateway response we depend on. Declared structurally and then
 * validated field by field, so an upstream change surfaces as a failed read
 * rather than as silently wrong numbers.
 */
interface GatewayChainRow {
  chain?: unknown;
  confirmedBalance?: unknown;
}

interface GatewayDepositorRow {
  depositor?: unknown;
  totalConfirmed?: unknown;
  breakdown?: unknown;
}

interface GatewayBalances {
  totalConfirmedBalance?: unknown;
  breakdown?: GatewayDepositorRow[];
}

async function probe(address: string): Promise<CrosschainBalanceReading> {
  const raw = (await withTimeout(
    appKit().unifiedBalance.getBalances({
      token: "USDC",
      networkType: "testnet",
      sources: [{ address }],
    }),
  )) as GatewayBalances;

  const depositor =
    raw.breakdown?.find(
      (row) => typeof row.depositor === "string" && row.depositor.toLowerCase() === address.toLowerCase(),
    ) ?? raw.breakdown?.[0];
  if (!depositor) {
    throw new Error("Circle Gateway returned no balance entry for the treasury wallet");
  }
  if (!Array.isArray(depositor.breakdown)) {
    throw new Error("Circle Gateway returned no per-chain breakdown");
  }

  const chains: CrosschainChainBalance[] = (depositor.breakdown as GatewayChainRow[])
    .map((row) => {
      if (typeof row.chain !== "string" || row.chain.length === 0) {
        throw new Error("Circle Gateway returned a chain row without an identifier");
      }
      return {
        chain: row.chain,
        label: labelFor(row.chain),
        confirmedBalance: requireDecimal(row.confirmedBalance, `balance for ${row.chain}`),
        isArc: row.chain === ARC_CHAIN,
      };
    })
    // Arc is the settlement chain, so it leads; Gateway's order holds for the rest.
    .sort((a, b) => Number(b.isArc) - Number(a.isArc));

  const totalConfirmed = requireDecimal(
    raw.totalConfirmedBalance ?? depositor.totalConfirmed,
    "total balance",
  );

  return {
    address,
    token: "USDC",
    source: "circle-gateway",
    available: true,
    deposited: isPositive(totalConfirmed) || chains.some((c) => isPositive(c.confirmedBalance)),
    totalConfirmed,
    chains,
    stale: false,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Read the treasury's Gateway balance, coalescing concurrent callers and
 * caching both outcomes. A failed refresh degrades to the last good reading
 * marked stale, or to an explicit unavailable result when nothing is cached.
 */
export async function readCrosschainBalance(address: string): Promise<CrosschainBalanceReading> {
  const entry = entryFor(address);
  // A stale reading is retried on the short failure TTL, not the success TTL.
  const ttl = entry.lastResult && !entry.lastResult.stale ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  if (entry.lastResult && Date.now() - entry.lastProbeAt < ttl) return entry.lastResult;
  if (entry.inFlight) return entry.inFlight;

  entry.inFlight = probe(address)
    .then((reading) => {
      entry.lastGood = reading;
      entry.lastResult = reading;
      return reading;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const reading: CrosschainBalanceReading = entry.lastGood
        ? { ...entry.lastGood, stale: true, error: message }
        : {
            address,
            token: "USDC",
            source: "circle-gateway",
            available: false,
            deposited: false,
            chains: [],
            stale: true,
            checkedAt: new Date().toISOString(),
            error: message,
          };
      entry.lastResult = reading;
      return reading;
    })
    .finally(() => {
      entry.lastProbeAt = Date.now();
      entry.inFlight = null;
    });

  return entry.inFlight;
}
