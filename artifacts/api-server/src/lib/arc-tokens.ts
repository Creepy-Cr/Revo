/**
 * Token identities Revo pins for itself on Arc Testnet.
 *
 * Venue registries are consulted at runtime but checked against these rather
 * than trusted. An address that changes underneath us is a reason to stop
 * trading, not a reason to follow it to a new contract.
 *
 * `tradable` is a Revo decision, not a venue capability. A venue will happily
 * quote a pool that is technically executable and economically nonsense; this
 * flag is where we record that we have looked at a pool and decided against it
 * regardless of what the venue reports.
 */

export interface ArcToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** How the treasury treats this leg: the stable side or the risk side. */
  role: "stable" | "risk";
  /** Label shown on the dashboard. */
  name: string;
  /**
   * CoinGecko id for the independent reference price. Every tradable token
   * needs one, because a pool rate that cannot be checked against a real
   * market is not something Revo will trade on.
   */
  coingeckoId: string;
  /** False when Revo refuses to route a trade in this token, whatever a venue says. */
  tradable: boolean;
  /** Why the token is held and priced but never traded. Present iff `tradable` is false. */
  untradableReason?: string;
}

export const ARC_TOKENS: Record<string, ArcToken> = {
  USDC: {
    symbol: "USDC",
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    role: "stable",
    name: "Liquid reserve",
    coingeckoId: "usd-coin",
    tradable: true,
  },
  EURC: {
    symbol: "EURC",
    address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
    decimals: 6,
    role: "risk",
    name: "Euro sleeve",
    coingeckoId: "euro-coin",
    tradable: true,
  },
  cirBTC: {
    symbol: "cirBTC",
    address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
    decimals: 8,
    role: "risk",
    name: "Bitcoin sleeve",
    coingeckoId: "bitcoin",
    tradable: false,
    // Measured directly from the pool contracts rather than taken from an
    // aggregator: the deepest cirBTC pool on Arc Testnet holds under 0.6
    // cirBTC and quotes it near 410,000 USDC while real BTC trades near
    // 80,000. Both the depth and the price are disqualifying on their own.
    untradableReason:
      "Arc Testnet's deepest cirBTC pool holds under 0.6 cirBTC and prices it around 5x the real BTC rate, so no trade in it can be economically meaningful",
  },
};

/** Back-compat alias for the original export name. */
export const ARC_TRADED_TOKENS = ARC_TOKENS;

export type TradedSymbol = keyof typeof ARC_TOKENS;

export function isTradedSymbol(symbol: string): symbol is TradedSymbol {
  return Object.prototype.hasOwnProperty.call(ARC_TOKENS, symbol);
}

/** Tokens Revo will actually route a trade in. */
export function tradableTokens(): ArcToken[] {
  return Object.values(ARC_TOKENS).filter((t) => t.tradable);
}
