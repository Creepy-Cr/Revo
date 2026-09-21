/**
 * Live market data from CoinGecko's free public API.
 *
 * Quotes are cached for 60 seconds. On upstream failure the last successful
 * quote is served (stale) so the dashboard keeps working; if no quote has
 * ever been fetched the caller receives null and must degrade explicitly -
 * we never fabricate prices.
 */

export interface MarketQuote {
  usdcUsd: number;
  /**
   * Real-world EURC price. This is the reference the EURC swap path is checked
   * against, and the price positions are marked at, because the Arc pool rate
   * sits well above the real euro and marking to it would invent profit.
   */
  eurUsd?: number;
  eurChange24h?: number;
  fetchedAt: number;
  stale: boolean;
}

const CACHE_TTL_MS = 60_000;
// Only the ids for assets the treasury can hold.
const ENDPOINT =
  "https://api.coingecko.com/api/v3/simple/price?ids=usd-coin,euro-coin&vs_currencies=usd&include_24hr_change=true";

/** CoinGecko id to the `MarketQuote` field carrying its USD price. */
export function referencePriceFor(coingeckoId: string, quote: MarketQuote | null): number | undefined {
  if (!quote) return undefined;
  switch (coingeckoId) {
    case "usd-coin":
      return quote.usdcUsd;
    case "euro-coin":
      return quote.eurUsd;
    default:
      return undefined;
  }
}

let cache: MarketQuote | null = null;

export async function getMarketQuote(): Promise<MarketQuote | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  try {
    const res = await fetch(ENDPOINT, {
      signal: AbortSignal.timeout(6_000),
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`CoinGecko responded ${res.status}`);
    }
    const json = (await res.json()) as {
      "usd-coin"?: { usd?: number };
      "euro-coin"?: { usd?: number; usd_24h_change?: number };
    };

    const usdcUsd = json["usd-coin"]?.usd;

    // USDC is the only required id: it prices the liquid reserve and the
    // deposit-ledger fallback, so a quote without it is not a usable quote.
    if (typeof usdcUsd !== "number") {
      throw new Error("CoinGecko returned an incomplete quote");
    }

    const eurUsd = json["euro-coin"]?.usd;
    const eurChange24h = json["euro-coin"]?.usd_24h_change;

    cache = {
      usdcUsd,
      ...(typeof eurUsd === "number" ? { eurUsd } : {}),
      ...(typeof eurChange24h === "number" ? { eurChange24h } : {}),
      fetchedAt: Date.now(),
      stale: false,
    };
    return cache;
  } catch (error) {
    if (cache) {
      // Serve the last real quote rather than failing the dashboard, but mark
      // it stale so callers can surface that honestly.
      return { ...cache, stale: true };
    }
    console.error("Market quote unavailable and no cached quote exists:", error);
    return null;
  }
}
