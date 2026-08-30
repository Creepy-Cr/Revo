/**
 * Live market data from CoinGecko's free public API.
 *
 * Quotes are cached for 60 seconds. On upstream failure the last successful
 * quote is served (stale) so the dashboard keeps working; if no quote has
 * ever been fetched the caller receives null and must degrade explicitly -
 * we never fabricate prices.
 */

export interface MarketQuote {
  ethUsd: number;
  ethChange24h: number;
  usdcUsd: number;
  fetchedAt: number;
  stale: boolean;
}

const CACHE_TTL_MS = 60_000;
const ENDPOINT =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin&vs_currencies=usd&include_24hr_change=true";

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
      ethereum?: { usd?: number; usd_24h_change?: number };
      "usd-coin"?: { usd?: number };
    };

    const ethUsd = json.ethereum?.usd;
    const ethChange24h = json.ethereum?.usd_24h_change;
    const usdcUsd = json["usd-coin"]?.usd;

    if (
      typeof ethUsd !== "number" ||
      typeof ethChange24h !== "number" ||
      typeof usdcUsd !== "number"
    ) {
      throw new Error("CoinGecko returned an incomplete quote");
    }

    cache = { ethUsd, ethChange24h, usdcUsd, fetchedAt: Date.now(), stale: false };
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
