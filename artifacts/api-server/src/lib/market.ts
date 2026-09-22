/**
 * Independent reference prices for every token Revo holds.
 *
 * Two sources, chosen by the token registry rather than by symbol switches:
 *
 * - CoinGecko's public simple-price endpoint for crypto assets, fetched in
 *   one batch at full precision (its default rounds sub-dollar moves away).
 * - Frankfurter's official fiat rates for fiat-backed tokens. These are
 *   central-bank reference fixes published once per business day, so an FX
 *   entry carries the date of its fix as well as when it was fetched.
 *
 * Each source is cached for 60 seconds and refreshed independently: one feed
 * failing must not blank the other. On failure the last successful read is
 * served marked stale; if a source has never succeeded its prices are simply
 * absent and every caller degrades explicitly. Prices are never fabricated.
 */

import { ARC_TOKENS, priceIdOf, type PriceSource } from "./arc-tokens";

export interface ReferencePrice {
  usd: number;
  /** 24h change in percent, where the source publishes one (CoinGecko only). */
  change24h?: number;
  /** When this source last fetched successfully. */
  fetchedAt: number;
  /** The datum's own time: the fix date for FX, the fetch time for spot. */
  asOf: number;
  source: PriceSource["kind"];
  /** True when served from cache after a failed refresh. */
  stale: boolean;
}

export interface MarketQuote {
  /** USDC, the anchor: it prices the reserve and the deposit-ledger fallback. */
  usdcUsd: number;
  /** Reference prices keyed by `priceIdOf(token.price)`. */
  prices: Record<string, ReferencePrice>;
  /** Oldest successful fetch among the sources present. */
  fetchedAt: number;
  /** True when any source is being served from cache after a failed refresh. */
  stale: boolean;
}

export const CACHE_TTL_MS = 60_000;

/**
 * An official fix older than this is not used. Four days covers a Friday fix
 * being the latest available through a Monday holiday; anything longer means
 * the source has stopped publishing and the token goes unpriced instead.
 */
export const MAX_FX_FIX_AGE_MS = 4 * 24 * 60 * 60_000;

const FETCH_TIMEOUT_MS = 6_000;
const USDC_PRICE_ID = priceIdOf(ARC_TOKENS.USDC!.price);

function coingeckoIds(): string[] {
  const ids = new Set<string>();
  for (const token of Object.values(ARC_TOKENS)) {
    if (token.price.kind === "coingecko") ids.add(token.price.id);
  }
  return [...ids].sort();
}

function fxCurrencies(): string[] {
  const currencies = new Set<string>();
  for (const token of Object.values(ARC_TOKENS)) {
    if (token.price.kind === "fx") currencies.add(token.price.currency);
  }
  return [...currencies].sort();
}

export function coingeckoEndpoint(ids: string[] = coingeckoIds()): string {
  return `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true&precision=full`;
}

/** Days of official fixes requested per poll, enough to hold the previous fix across a long weekend. */
const FX_WINDOW_DAYS = 7;

export function frankfurterEndpoint(currencies: string[] = fxCurrencies(), now = Date.now()): string {
  const from = new Date(now - FX_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  return `https://api.frankfurter.dev/v2/rates?base=USD&quotes=${currencies.join(",")}&from=${from}`;
}

/** Reference price for a token's source, or undefined when none is usable. */
export function referencePriceFor(priceId: string, quote: MarketQuote | null): number | undefined {
  return quote?.prices[priceId]?.usd;
}

/** The full entry, for callers that need its age or 24h change. */
export function referenceEntryFor(priceId: string, quote: MarketQuote | null): ReferencePrice | undefined {
  return quote?.prices[priceId];
}

interface SourceCache<T> {
  data: T;
  fetchedAt: number;
}

type CoingeckoPrices = Record<string, { usd: number; change24h?: number }>;
type FxRates = Record<string, { usdPerUnit: number; asOf: number; changePct?: number }>;

let coingeckoCache: SourceCache<CoingeckoPrices> | null = null;
let fxCache: SourceCache<FxRates> | null = null;

/** Test seam: forget every cached read. */
export function resetMarketCache(): void {
  coingeckoCache = null;
  fxCache = null;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`${new URL(url).host} responded ${res.status}`);
  }
  return res.json();
}

async function fetchCoingecko(): Promise<CoingeckoPrices> {
  const json = (await fetchJson(coingeckoEndpoint())) as Record<
    string,
    { usd?: unknown; usd_24h_change?: unknown } | undefined
  >;
  const prices: CoingeckoPrices = {};
  for (const id of coingeckoIds()) {
    const row = json?.[id];
    const usd = row?.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) continue;
    const change = row?.usd_24h_change;
    prices[id] = {
      usd,
      ...(typeof change === "number" && Number.isFinite(change) ? { change24h: change } : {}),
    };
  }
  // USDC is the only required id: without it nothing downstream can value
  // the reserve, so an answer missing it is not a usable answer.
  if (!prices["usd-coin"]) {
    throw new Error("CoinGecko returned an incomplete quote");
  }
  return prices;
}

/**
 * Frankfurter v2 returns one row per quote currency and fix date: the number
 * of units of that currency per base unit. A token that represents one unit
 * of the currency is therefore worth 1/rate USD. The newest fix is the
 * price; the one before it gives the day-on-day change, so an FX token's
 * momentum comes from the same official source as its price.
 */
async function fetchFrankfurter(): Promise<FxRates> {
  const json = (await fetchJson(frankfurterEndpoint())) as unknown;
  if (!Array.isArray(json)) {
    throw new Error("Frankfurter returned an unexpected shape");
  }
  const fixes = new Map<string, { asOf: number; rate: number }[]>();
  for (const row of json as { base?: unknown; quote?: unknown; rate?: unknown; date?: unknown }[]) {
    if (row.base !== "USD" || typeof row.quote !== "string") continue;
    if (typeof row.rate !== "number" || !Number.isFinite(row.rate) || row.rate <= 0) continue;
    if (typeof row.date !== "string") continue;
    const asOf = Date.parse(`${row.date}T00:00:00Z`);
    if (!Number.isFinite(asOf)) continue;
    const list = fixes.get(row.quote) ?? [];
    list.push({ asOf, rate: row.rate });
    fixes.set(row.quote, list);
  }
  const rates: FxRates = {};
  for (const [currency, list] of fixes) {
    list.sort((a, b) => b.asOf - a.asOf);
    const [latest, previous] = list;
    if (!latest) continue;
    rates[currency] = {
      usdPerUnit: 1 / latest.rate,
      asOf: latest.asOf,
      // USD per unit fell if the currency needs more units per dollar.
      ...(previous ? { changePct: (previous.rate / latest.rate - 1) * 100 } : {}),
    };
  }
  if (Object.keys(rates).length === 0) {
    throw new Error("Frankfurter returned no usable rates");
  }
  return rates;
}

/**
 * Refreshes one source if its cache has expired. Returns the data to serve
 * and whether it is being served stale. Never throws: a source that cannot
 * be read and has never been read simply contributes nothing.
 */
async function refresh<T>(
  cache: SourceCache<T> | null,
  load: () => Promise<T>,
  store: (next: SourceCache<T>) => void,
  label: string,
  now: number,
): Promise<{ data: T; fetchedAt: number; stale: boolean } | null> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { data: cache.data, fetchedAt: cache.fetchedAt, stale: false };
  }
  try {
    const data = await load();
    const next = { data, fetchedAt: Date.now() };
    store(next);
    return { ...next, stale: false };
  } catch (error) {
    if (cache) {
      // Serve the last real read rather than blanking the dashboard, but mark
      // it stale so callers can surface that honestly.
      return { data: cache.data, fetchedAt: cache.fetchedAt, stale: true };
    }
    console.error(`${label} unavailable and no cached read exists:`, error);
    return null;
  }
}

export async function getMarketQuote(): Promise<MarketQuote | null> {
  const now = Date.now();
  const wantsFx = fxCurrencies().length > 0;
  const [gecko, fx] = await Promise.all([
    refresh(coingeckoCache, fetchCoingecko, (c) => (coingeckoCache = c), "CoinGecko", now),
    wantsFx ? refresh(fxCache, fetchFrankfurter, (c) => (fxCache = c), "Frankfurter", now) : Promise.resolve(null),
  ]);

  // The anchor source decides whether there is a quote at all.
  if (!gecko) return null;

  const prices: Record<string, ReferencePrice> = {};
  for (const [id, row] of Object.entries(gecko.data)) {
    prices[priceIdOf({ kind: "coingecko", id })] = {
      usd: row.usd,
      ...(row.change24h !== undefined ? { change24h: row.change24h } : {}),
      fetchedAt: gecko.fetchedAt,
      asOf: gecko.fetchedAt,
      source: "coingecko",
      stale: gecko.stale,
    };
  }
  if (fx) {
    for (const [currency, row] of Object.entries(fx.data)) {
      // A fix that is too old is dropped rather than served: the token then
      // shows as unpriced, which is the truthful state.
      if (Date.now() - row.asOf > MAX_FX_FIX_AGE_MS) continue;
      prices[priceIdOf({ kind: "fx", currency })] = {
        usd: row.usdPerUnit,
        ...(row.changePct !== undefined ? { change24h: row.changePct } : {}),
        fetchedAt: fx.fetchedAt,
        asOf: row.asOf,
        source: "fx",
        stale: fx.stale,
      };
    }
  }

  const usdcUsd = prices[USDC_PRICE_ID]?.usd;
  if (usdcUsd === undefined) return null;

  const fetchedAts = [gecko.fetchedAt, ...(fx ? [fx.fetchedAt] : [])];
  return {
    usdcUsd,
    prices,
    fetchedAt: Math.min(...fetchedAts),
    stale: gecko.stale || (fx?.stale ?? false),
  };
}
