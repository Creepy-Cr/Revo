/**
 * Token identities Revo pins for itself on Arc mainnet (chain 5042).
 *
 * Venue registries are consulted at runtime but checked against these rather
 * than trusted. An address that changes underneath us is a reason to stop
 * trading, not a reason to follow it to a new contract.
 *
 * The set is deliberately small: USDC (the reserve and the gas asset) and
 * Circle's EURC, the one pair with measured Uniswap v4 depth on mainnet. Any
 * further token must pass the same pool depth and reference price checks on
 * mainnet before it is added here, and must then be added to every other
 * place the token set is restated (OpenAPI enums, the web console, prompts).
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
    address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    decimals: 6,
    role: "risk",
    name: "Euro sleeve",
    coingeckoId: "euro-coin",
    tradable: true,
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
