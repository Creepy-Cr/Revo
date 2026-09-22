/**
 * Token identities Revo pins for itself on Arc mainnet (chain 5042).
 *
 * Venue registries are consulted at runtime but checked against these rather
 * than trusted. An address that changes underneath us is a reason to stop
 * trading, not a reason to follow it to a new contract.
 *
 * Every token here was verified against its issuer's own documentation
 * (docs.arc.io contract registry, Circle's asset pages, Maple's crosschain
 * page) on 22 September 2026. Symbol, name or bytecode similarity is not
 * identity: Arc's Uniswap v4 carries tokens named CRCL, NVDA, SPY, AAPL, TSLA
 * and VIRTUAL that were minted by an anonymous wallet with no issuer, no
 * backing and no published address anywhere, and they are deliberately absent.
 *
 * Adding a token means all of the following, in order:
 * 1. Issuer documentation naming this exact address on Arc mainnet.
 * 2. A hook-less Uniswap v4 pool against USDC, read over RPC, with in-range
 *    liquidity. Hooked pools are never pinned: a hook can change the pool's
 *    accounting arbitrarily and Revo cannot audit one per trade.
 * 3. An independent reference price the pool can be checked against.
 * 4. Restating the token wherever the set is restated: OpenAPI, the console,
 *    the policy compiler and chat prompts, and the public copy.
 *
 * `tradable` is a Revo decision, not a venue capability. A venue will happily
 * quote a pool that is technically executable and economically nonsense; this
 * flag is where we record that we have looked at a pool and decided against it
 * regardless of what the venue reports.
 */

/** A hook-less Uniswap v4 pool key fragment for this token against USDC. */
export interface PinnedPool {
  fee: number;
  tickSpacing: number;
}

/**
 * Where the token's independent USD reference price comes from.
 *
 * - `coingecko`: CoinGecko's simple price endpoint, by CoinGecko id.
 * - `fx`: an official fiat rate from Frankfurter (central-bank reference
 *   rates, one fix per business day), for tokens that represent one unit
 *   of a fiat currency.
 */
export type PriceSource =
  | { kind: "coingecko"; id: string }
  | { kind: "fx"; currency: string };

/**
 * The issuer-side controls the token contract exposes, read before every
 * signing. Circle's FiatToken has `paused()` and `isBlacklisted(address)`;
 * Ripio's wARS has `paused()` and `isBlocked(address)`; bridged WETH exposes
 * only `paused()`; Maple's syrupUSDC exposes none of them. A control that is
 * not listed is not probed, because calling a function the contract does not
 * have reverts and would look like an RPC failure on every trade.
 */
export type IssuerControl = "paused" | "isBlacklisted" | "isBlocked";

export interface ArcToken {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  /** How the treasury treats this leg: the stable side or the risk side. */
  role: "stable" | "risk";
  /** Label shown on the dashboard. */
  name: string;
  /** Who stands behind the token, for operator-facing copy. */
  issuer: string;
  /**
   * Independent reference price. Every held token needs one, because a pool
   * rate that cannot be checked against a real market is not something Revo
   * will trade on, and a holding that cannot be priced makes the total wrong.
   */
  price: PriceSource;
  /**
   * Hook-less Uniswap v4 pools against USDC that Revo will quote, measured on
   * mainnet. Empty for USDC itself. Every trade Revo routes has USDC on one
   * side, so these keys are the whole routing table.
   */
  pools: ReadonlyArray<PinnedPool>;
  /** Issuer controls this contract actually exposes. */
  issuerControls: ReadonlyArray<IssuerControl>;
  /** False when Revo refuses to route a trade in this token, whatever a venue says. */
  tradable: boolean;
  /** Why the token is held and priced but never traded. Present iff `tradable` is false. */
  untradableReason?: string;
}

const CIRCLE_FIATTOKEN_CONTROLS: ReadonlyArray<IssuerControl> = ["paused", "isBlacklisted"];

export const ARC_TOKENS: Record<string, ArcToken> = {
  USDC: {
    symbol: "USDC",
    address: "0x3600000000000000000000000000000000000000",
    decimals: 6,
    role: "stable",
    name: "Liquid reserve",
    issuer: "Circle",
    price: { kind: "coingecko", id: "usd-coin" },
    pools: [],
    issuerControls: CIRCLE_FIATTOKEN_CONTROLS,
    tradable: true,
  },
  EURC: {
    symbol: "EURC",
    address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
    decimals: 6,
    role: "risk",
    name: "Euro sleeve",
    issuer: "Circle",
    price: { kind: "coingecko", id: "euro-coin" },
    // Uniswap's standard tiers plus the two 1-tick-spacing stable tiers. The
    // 0.05% pool carries the depth; the rest are quoted in case that changes.
    pools: [
      { fee: 10, tickSpacing: 1 },
      { fee: 100, tickSpacing: 1 },
      { fee: 500, tickSpacing: 10 },
      { fee: 3000, tickSpacing: 60 },
      { fee: 10000, tickSpacing: 200 },
    ],
    issuerControls: CIRCLE_FIATTOKEN_CONTROLS,
    tradable: true,
  },
  syrupUSDC: {
    symbol: "syrupUSDC",
    address: "0x0dC6b79F3c3854E4d74514fD4d29BE6c96Beee39",
    decimals: 6,
    role: "risk",
    name: "Maple yield sleeve",
    issuer: "Maple Finance",
    price: { kind: "coingecko", id: "syrupusdc" },
    // 0.05% / tick spacing 5: about 500k USDC of in-range depth on 22 Sep 2026.
    pools: [{ fee: 500, tickSpacing: 5 }],
    // Maple's crosschain token exposes no pause or blocklist view functions.
    issuerControls: [],
    tradable: true,
  },
  cirBTC: {
    symbol: "cirBTC",
    address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0",
    decimals: 8,
    role: "risk",
    name: "Bitcoin sleeve",
    issuer: "Circle",
    price: { kind: "coingecko", id: "bitcoin" },
    // 0.3% / tick spacing 30 is the only hook-less cirBTC pool; the deeper
    // cirBTC pools on Arc run hooks and are not pinned.
    pools: [{ fee: 3000, tickSpacing: 30 }],
    issuerControls: CIRCLE_FIATTOKEN_CONTROLS,
    tradable: true,
  },
  WETH: {
    symbol: "WETH",
    address: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB",
    decimals: 18,
    role: "risk",
    name: "Ether sleeve",
    issuer: "Arc bridge (lock on Ethereum, mint on Arc)",
    price: { kind: "coingecko", id: "ethereum" },
    // 0.25% / tick spacing 25 is the only hook-less WETH pool on Arc.
    pools: [{ fee: 2500, tickSpacing: 25 }],
    issuerControls: ["paused"],
    tradable: true,
  },
  wARS: {
    symbol: "wARS",
    address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D",
    decimals: 18,
    role: "risk",
    name: "Argentine peso sleeve",
    issuer: "Ripio",
    price: { kind: "fx", currency: "ARS" },
    // 0.01% / tick spacing 1, about 24k USDC of depth on 22 Sep 2026.
    pools: [{ fee: 100, tickSpacing: 1 }],
    issuerControls: ["paused", "isBlocked"],
    tradable: false,
    untradableReason:
      "Arc's wARS pool trades about 5% below the official BCRA peso rate, the only independent reference available, so Revo cannot tell a fair fill from a bad one and does not trade it.",
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

/** Tokens on the risk side that Revo may size a sleeve in. */
export function tradableRiskTokens(): ArcToken[] {
  return tradableTokens().filter((t) => t.role === "risk");
}

/** The pinned token at this address, if any. Case-insensitive. */
export function tokenByAddress(address: string): ArcToken | undefined {
  const wanted = address.toLowerCase();
  return Object.values(ARC_TOKENS).find((t) => t.address.toLowerCase() === wanted);
}

/**
 * Stable string identity of a token's reference price, used as the key into
 * the market quote. Two tokens sharing a source share a price.
 */
export function priceIdOf(source: PriceSource): string {
  return source.kind === "coingecko" ? `coingecko:${source.id}` : `fx:${source.currency}`;
}

/** Sentence-length description of where a token's reference price comes from. */
export function describePriceSource(source: PriceSource): string {
  return source.kind === "coingecko"
    ? `CoinGecko (${source.id})`
    : `Frankfurter official ${source.currency} rate (central-bank reference, daily)`;
}
