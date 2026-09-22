/**
 * The market module is the only place Revo learns what its holdings are
 * worth away from the pool it trades in. These tests replace `fetch` and
 * check the parts that matter downstream: which prices are keyed how, what
 * happens when one feed fails, and that a stale official fix is dropped
 * rather than served as if it were today's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_TTL_MS,
  MAX_FX_FIX_AGE_MS,
  coingeckoEndpoint,
  frankfurterEndpoint,
  getMarketQuote,
  referencePriceFor,
  resetMarketCache,
} from "./market";

type Handler = (url: string) => Promise<Response> | Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const geckoBody = {
  "usd-coin": { usd: 0.9998, usd_24h_change: 0.01 },
  "euro-coin": { usd: 1.1634, usd_24h_change: -0.3 },
  bitcoin: { usd: 110_000, usd_24h_change: 2.5 },
  ethereum: { usd: 4_000, usd_24h_change: 1.1 },
  syrupusdc: { usd: 1.1201 },
};

function fixDate(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString().slice(0, 10);
}

let handler: Handler;
const fetchMock = vi.fn(async (input: string | URL | Request) => handler(String(input)));

beforeEach(() => {
  resetMarketCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-22T09:00:00Z"));
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  handler = (url) => {
    if (url.startsWith("https://api.coingecko.com/")) return json(geckoBody);
    if (url.startsWith("https://api.frankfurter.dev/")) {
      return json([
        { date: fixDate(36 * 3_600_000), base: "USD", quote: "ARS", rate: 1500 },
        { date: fixDate(12 * 3_600_000), base: "USD", quote: "ARS", rate: 1514.5 },
      ]);
    }
    return json({ error: "unexpected" }, 500);
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("endpoints", () => {
  it("asks CoinGecko for every registered id at full precision, in one call", () => {
    const url = new URL(coingeckoEndpoint());
    expect(url.searchParams.get("precision")).toBe("full");
    expect(url.searchParams.get("ids")!.split(",")).toEqual(
      ["bitcoin", "ethereum", "euro-coin", "syrupusdc", "usd-coin"],
    );
  });

  it("asks Frankfurter for a week of official fixes of the registered currencies against USD", () => {
    const url = new URL(frankfurterEndpoint());
    expect(url.searchParams.get("base")).toBe("USD");
    expect(url.searchParams.get("quotes")).toBe("ARS");
    expect(url.searchParams.get("from")).toBe("2026-09-15");
  });
});

describe("getMarketQuote", () => {
  it("keys every price by its source id and inverts FX rates into USD per unit", async () => {
    const quote = await getMarketQuote();
    expect(quote).not.toBeNull();
    expect(quote!.usdcUsd).toBe(0.9998);
    expect(referencePriceFor("coingecko:euro-coin", quote)).toBe(1.1634);
    expect(quote!.prices["coingecko:euro-coin"]?.change24h).toBe(-0.3);
    expect(quote!.prices["coingecko:syrupusdc"]?.change24h).toBeUndefined();
    expect(referencePriceFor("fx:ARS", quote)).toBeCloseTo(1 / 1514.5, 9);
    expect(quote!.prices["fx:ARS"]?.source).toBe("fx");
    expect(quote!.stale).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("prices FX from the newest fix and takes its change from the fix before, whatever the row order", async () => {
    handler = (url) =>
      url.includes("coingecko")
        ? json(geckoBody)
        : json([
            { date: fixDate(12 * 3_600_000), base: "USD", quote: "ARS", rate: 1514.5 },
            { date: fixDate(60 * 3_600_000), base: "USD", quote: "ARS", rate: 1490 },
            { date: fixDate(36 * 3_600_000), base: "USD", quote: "ARS", rate: 1500 },
          ]);
    const quote = await getMarketQuote();
    const ars = quote!.prices["fx:ARS"]!;
    expect(ars.usd).toBeCloseTo(1 / 1514.5, 9);
    // The peso needs more units per dollar than yesterday, so each unit is worth less.
    expect(ars.change24h).toBeCloseTo((1500 / 1514.5 - 1) * 100, 9);
    expect(ars.change24h!).toBeLessThan(0);
  });

  it("leaves the FX change unknown when only one fix came back", async () => {
    handler = (url) =>
      url.includes("coingecko")
        ? json(geckoBody)
        : json([{ date: fixDate(12 * 3_600_000), base: "USD", quote: "ARS", rate: 1514.5 }]);
    const quote = await getMarketQuote();
    expect(quote!.prices["fx:ARS"]?.usd).toBeCloseTo(1 / 1514.5, 9);
    expect(quote!.prices["fx:ARS"]?.change24h).toBeUndefined();
  });

  it("serves both sources from cache inside the TTL and refreshes after it", async () => {
    await getMarketQuote();
    await getMarketQuote();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    await getMarketQuote();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("returns nothing when the anchor source has never answered", async () => {
    handler = (url) => (url.includes("coingecko") ? json({}, 502) : json([]));
    expect(await getMarketQuote()).toBeNull();
  });

  it("refuses a CoinGecko answer that omits USDC", async () => {
    handler = (url) => (url.includes("coingecko") ? json({ bitcoin: { usd: 1 } }) : json([]));
    expect(await getMarketQuote()).toBeNull();
  });

  it("leaves an FX token unpriced, rather than blanking the quote, when Frankfurter is down", async () => {
    handler = (url) => (url.includes("coingecko") ? json(geckoBody) : json({ message: "down" }, 503));
    const quote = await getMarketQuote();
    expect(quote).not.toBeNull();
    expect(referencePriceFor("fx:ARS", quote)).toBeUndefined();
    expect(referencePriceFor("coingecko:bitcoin", quote)).toBe(110_000);
    expect(quote!.stale).toBe(false);
  });

  it("marks only the failed source stale and keeps its last good read", async () => {
    const first = await getMarketQuote();
    expect(first!.prices["fx:ARS"]?.stale).toBe(false);
    vi.advanceTimersByTime(CACHE_TTL_MS + 1);
    handler = (url) => (url.includes("coingecko") ? json(geckoBody) : json({}, 503));
    const second = await getMarketQuote();
    expect(second!.stale).toBe(true);
    expect(second!.prices["fx:ARS"]?.stale).toBe(true);
    expect(second!.prices["coingecko:usd-coin"]?.stale).toBe(false);
    expect(referencePriceFor("fx:ARS", second)).toBeCloseTo(1 / 1514.5, 9);
  });

  it("drops an official fix that is older than the allowed age", async () => {
    handler = (url) =>
      url.includes("coingecko")
        ? json(geckoBody)
        : json([{ date: fixDate(MAX_FX_FIX_AGE_MS + 24 * 3_600_000), base: "USD", quote: "ARS", rate: 1500 }]);
    const quote = await getMarketQuote();
    expect(quote).not.toBeNull();
    expect(referencePriceFor("fx:ARS", quote)).toBeUndefined();
  });

  it("ignores malformed rows and non-positive prices instead of pricing from them", async () => {
    handler = (url) =>
      url.includes("coingecko")
        ? json({ ...geckoBody, bitcoin: { usd: -5 }, ethereum: { usd: "4000" } })
        : json([
            { date: fixDate(0), base: "EUR", quote: "ARS", rate: 1700 },
            { date: fixDate(0), base: "USD", quote: "ARS", rate: 0 },
          ]);
    const quote = await getMarketQuote();
    expect(quote).not.toBeNull();
    expect(referencePriceFor("coingecko:bitcoin", quote)).toBeUndefined();
    expect(referencePriceFor("coingecko:ethereum", quote)).toBeUndefined();
    expect(referencePriceFor("fx:ARS", quote)).toBeUndefined();
  });
});
