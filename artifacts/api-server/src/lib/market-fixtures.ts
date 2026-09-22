/**
 * Test fixtures for market quotes. Not imported by production code.
 *
 * Builds a `MarketQuote` in the shape `getMarketQuote` returns, keyed by the
 * registry's price ids, so a test can say "USDC at 1, EURC at 1.16" without
 * restating how prices are keyed.
 */
import { ARC_TOKENS, priceIdOf } from "./arc-tokens";
import type { MarketQuote, ReferencePrice } from "./market";

/** A quote where each named symbol is priced; anything unnamed is absent. */
export function quoteFor(
  usdBySymbol: Record<string, number | undefined>,
  overrides: Partial<Omit<MarketQuote, "prices">> & {
    change24hBySymbol?: Record<string, number>;
    entry?: Partial<ReferencePrice>;
  } = {},
): MarketQuote {
  const fetchedAt = overrides.fetchedAt ?? Date.now();
  const prices: Record<string, ReferencePrice> = {};
  for (const [symbol, usd] of Object.entries(usdBySymbol)) {
    if (usd === undefined) continue;
    const token = ARC_TOKENS[symbol];
    if (!token) throw new Error(`quoteFor: ${symbol} is not a pinned token`);
    const change = overrides.change24hBySymbol?.[symbol];
    prices[priceIdOf(token.price)] = {
      usd,
      ...(change !== undefined ? { change24h: change } : {}),
      fetchedAt,
      asOf: fetchedAt,
      source: token.price.kind,
      stale: overrides.stale ?? false,
      ...overrides.entry,
    };
  }
  const usdc = usdBySymbol.USDC;
  if (usdc === undefined) throw new Error("quoteFor: USDC is the anchor and must be priced");
  return {
    usdcUsd: usdc,
    prices,
    fetchedAt,
    stale: overrides.stale ?? false,
  };
}
