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
  /**
   * Real-world BTC price. It sanity checks cirBTC swap quotes against a market
   * rather than against the testnet pool that quotes them, and it is the
   * reference the cirBTC signal is built on.
   *
   * Optional on purpose: CoinGecko occasionally omits an id. A missing BTC
   * price degrades only the swap check and drops the cirBTC momentum
   * component; it never takes down the dashboard.
   */
  btcUsd?: number;
  btcChange24h?: number;
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
const ENDPOINT =
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,usd-coin,bitcoin,euro-coin&vs_currencies=usd&include_24hr_change=true";

/** CoinGecko id to the `MarketQuote` field carrying its USD price. */
export function referencePriceFor(coingeckoId: string, quote: MarketQuote | null): number | undefined {
  if (!quote) return undefined;
  switch (coingeckoId) {
    case "usd-coin":
      return quote.usdcUsd;
    case "ethereum":
      return quote.ethUsd;
    case "bitcoin":
      return quote.btcUsd;
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
      ethereum?: { usd?: number; usd_24h_change?: number };
      "usd-coin"?: { usd?: number };
      bitcoin?: { usd?: number; usd_24h_change?: number };
      "euro-coin"?: { usd?: number; usd_24h_change?: number };
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

    const btcUsd = json.bitcoin?.usd;
    const btcChange24h = json.bitcoin?.usd_24h_change;
    const eurUsd = json["euro-coin"]?.usd;
    const eurChange24h = json["euro-coin"]?.usd_24h_change;

    cache = {
      ethUsd,
      ethChange24h,
      usdcUsd,
      ...(typeof btcUsd === "number" ? { btcUsd } : {}),
      ...(typeof btcChange24h === "number" ? { btcChange24h } : {}),
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
