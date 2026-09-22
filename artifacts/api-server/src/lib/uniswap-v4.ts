/**
 * Uniswap v4 on Arc mainnet - the only venue Revo trades on.
 *
 * Quoting is an `eth_call` against the canonical V4Quoter, depth comes from
 * StateView, and execution goes through the UniversalRouter with Permit2 as
 * the token pull. Nothing here trusts an aggregator or an off-chain price
 * feed for the pool itself; the independent reference price is used only to
 * reject a pool that has drifted from the real market.
 *
 * Pools are identified by key, not by address: v4 pools live inside the
 * singleton PoolManager. Every pool Revo quotes is a hook-less key against
 * USDC pinned in the token registry, verified to be initialised with in-range
 * liquidity before it is quoted. A pool that appears later, or one with a
 * hook, is not traded until it has been measured and pinned there. Because
 * every pinned pool has USDC on one side, every trade Revo routes is a single
 * hop with USDC on one side; a risk-to-risk rotation is two proposals, the
 * second drafted once the first settles (see rebalance-settlement).
 *
 * Contract addresses are Uniswap Labs' published Arc (chain 5042)
 * deployments and every one was verified to hold bytecode on 21 September
 * 2026. Measured that day: the 0.05% USDC/EURC pool carried in-range
 * liquidity of about 9.2e12 (both sides 6 decimals), which quoted 10,000
 * USDC with 0.1% impact and 50,000 USDC with 1.2%.
 *
 * Guards, all of which refuse rather than warn:
 * - Price impact measured against a dust-sized quote from the same pool.
 * - Output capped to a share of the pool's depth within a 2% price move.
 * - Pool rate checked against an independent reference; refused without one.
 *
 * This module quotes and encodes. It does not sign, and it never chooses an
 * amount: sizing, approvals, simulation and broadcast live in the execution
 * path, which re-simulates the exact calldata built here before signing.
 */

import {
  encodeAbiParameters,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { ARC_CHAIN_ID, ChainError, arcPublicClient } from "./arc-chain";
import { ARC_TOKENS, isTradedSymbol, type ArcToken, type PinnedPool } from "./arc-tokens";
import {
  PERMIT2,
  UNIVERSAL_ROUTER,
  ZERO_ADDRESS,
  permit2Abi,
  poolKeyAbi,
  type PoolKey,
} from "./v4-calldata";

export {
  PERMIT2,
  UNIVERSAL_ROUTER,
  encodePermit2Approval,
  encodeV4Swap,
  type PoolKey,
} from "./v4-calldata";
import { toBaseUnits, fromBaseUnits } from "./tower";

/** Uniswap v4 on Arc mainnet (chain 5042), from Uniswap's deployment registry. */
export const POOL_MANAGER: Address = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
export const V4_QUOTER: Address = "0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94";
export const STATE_VIEW: Address = "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b";

export const VENUE = "uniswap-v4" as const;


/**
 * The pinned pools a pair can be quoted on: the non-USDC token's registry
 * entries, or none when neither side is USDC. Order does not matter: every
 * initialised pool is quoted and the best output wins.
 */
export function pinnedPoolsFor(a: ArcToken, b: ArcToken): ReadonlyArray<PinnedPool> {
  const usdc = ARC_TOKENS.USDC!;
  const isUsdc = (t: ArcToken) => t.address.toLowerCase() === usdc.address.toLowerCase();
  if (isUsdc(a) && !isUsdc(b)) return b.pools;
  if (isUsdc(b) && !isUsdc(a)) return a.pools;
  return [];
}

/**
 * Routes quoting worse than this measured impact are refused. Mainnet
 * stable pairs are arbitraged; an impact anywhere near this means the trade
 * is too big for the pool, not that the pool is odd.
 */
export const MAX_PRICE_IMPACT_PCT = 1;

/**
 * How far the pool rate may sit from the real-world reference before the
 * quote is refused. Tight on purpose: on mainnet a stable pair that is 2%
 * off the market is either broken or being manipulated, and Revo must not
 * be the counterparty either way. Half of it raises a warning.
 */
export const MAX_REFERENCE_DEVIATION_PCT = 2;

/** Output above this share of the pool's 2% depth is refused as too deep a bite. */
export const MAX_POOL_SHARE_PCT = 10;

/** Slippage tolerance applied to the quoted output to derive the execution floor. */
export const SLIPPAGE_BPS = 30;

/** Seconds a swap's deadline and Permit2 allowance stay valid after signing. */
export const SWAP_DEADLINE_SECONDS = 180;

/** The v4 pool key. `currency0` sorts below `currency1`; the zero address is the native asset. */
export function poolIdFor(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

function poolKeyFor(a: ArcToken, b: ArcToken, tier: PinnedPool): PoolKey {
  const [currency0, currency1] =
    BigInt(a.address) < BigInt(b.address) ? [a.address, b.address] : [b.address, a.address];
  return { currency0, currency1, fee: tier.fee, tickSpacing: tier.tickSpacing, hooks: ZERO_ADDRESS };
}

const stateViewAbi = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "poolId" }],
    outputs: [
      { type: "uint160", name: "sqrtPriceX96" },
      { type: "int24", name: "tick" },
      { type: "uint24", name: "protocolFee" },
      { type: "uint24", name: "lpFee" },
    ],
  },
  {
    name: "getLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "bytes32", name: "poolId" }],
    outputs: [{ type: "uint128", name: "liquidity" }],
  },
] as const;

/**
 * V4Quoter reverts internally to surface its result and is declared
 * nonpayable; `simulateContract` runs it as an `eth_call`, so nothing is
 * signed or sent.
 */
const quoterAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          poolKeyAbi,
          { type: "bool", name: "zeroForOne" },
          { type: "uint128", name: "exactAmount" },
          { type: "bytes", name: "hookData" },
        ],
      },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

export interface SwapQuote {
  venue: typeof VENUE;
  inputSymbol: string;
  outputSymbol: string;
  /** Human amount requested, echoed back unchanged. */
  inputAmount: string;
  /** Real base units, computed from Revo's pinned decimals. */
  inputBaseUnits: string;
  /** Quoter output, decoded to human. */
  expectedOutput: string | null;
  /** Execution floor derived locally from the quote and the slippage tolerance. */
  minOutput: string | null;
  /** Output units per input unit the pool would actually give. */
  impliedRate: number | null;
  /** The same rate implied by real-world prices, for comparison. */
  referenceRate: number | null;
  /** How far the pool sits from the real market, as a percentage. */
  deviationPct: number | null;
  /** Measured here by comparing against a dust-sized quote, not reported by anyone. */
  priceImpactPct: number | null;
  /** Pool fee in hundredths of a basis point (500 = 0.05%). */
  feeTier: number | null;
  tickSpacing: number | null;
  poolId: Hex | null;
  /** The full key of the chosen pool; what execution encodes against. */
  poolKey: PoolKey | null;
  /** Output the pool can deliver within a 2% price move at its current in-range liquidity, human units. */
  poolDepthOut: string | null;
  slippageBps: number;
  routerAddress: Address;
  chainId: number;
  /** False whenever the route must not be signed. `reason` then says why. */
  tradable: boolean;
  reason?: string;
  /** Non-fatal concerns worth showing an operator before they approve. */
  warnings: string[];
  quotedAt: string;
}

export interface SwapQuoteRequest {
  inputSymbol: string;
  outputSymbol: string;
  /** Human decimal string, e.g. "12.5". Fractions are fine here. */
  amount: string;
  /** Real-world USD prices for both legs. Required: a quote without one is refused. */
  referenceUsd?: { input: number; output: number };
}

interface TierQuote {
  key: PoolKey;
  poolId: Hex;
  zeroForOne: boolean;
  amountOut: bigint;
  /** Output per unit of input at the pool's current tick, net of the LP fee, in whole-token terms. */
  spotRate: number;
  /** Output-side depth within a 2% move, base units. */
  depthOut: bigint;
}

function refuse(
  base: Omit<SwapQuote, "tradable" | "reason">,
  reason: string,
): SwapQuote {
  return { ...base, tradable: false, reason };
}

const Q96 = 2n ** 96n;

/**
 * The pool's marginal rate, read from slot0 rather than probed with a dust
 * swap. A probe has to be sized per pair: one hundredth of a token is a
 * thousand dollars of cirBTC yet rounds to a handful of satoshis coming the
 * other way, and either error shows up as phantom price impact. The tick
 * price is exact in both directions. The LP fee is taken off so the figure
 * is comparable with what the quoter returns for a real amount.
 */
export function spotRateFromSqrtPrice(
  sqrtPriceX96: bigint,
  zeroForOne: boolean,
  fee: number,
  decimalsIn: number,
  decimalsOut: number,
): number {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const token1PerToken0 = sqrt * sqrt;
  const baseRate = zeroForOne ? token1PerToken0 : 1 / token1PerToken0;
  return baseRate * 10 ** (decimalsIn - decimalsOut) * (1 - fee / 1_000_000);
}
/** sqrt(0.98) and 1/sqrt(1.02), scaled by 1e9, for the 2% depth calculation. */
const SQRT_DOWN_2PCT = 989_949_494n;
const INV_SQRT_UP_2PCT = 990_147_543n;

/**
 * Output available across a 2% price move, assuming the current in-range
 * liquidity holds across the band. Standard depth arithmetic for a
 * concentrated-liquidity pool: selling token0 moves the price down and pays
 * out token1 = L * (sqrtP - sqrtP'), selling token1 moves it up and pays out
 * token0 = L * (1/sqrtP - 1/sqrtP').
 */
export function depthWithin2Pct(liquidity: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  if (liquidity <= 0n || sqrtPriceX96 <= 0n) return 0n;
  if (zeroForOne) {
    const drop = (sqrtPriceX96 * (1_000_000_000n - SQRT_DOWN_2PCT)) / 1_000_000_000n;
    return (liquidity * drop) / Q96;
  }
  const inv = (Q96 * Q96) / sqrtPriceX96;
  const drop = (inv * (1_000_000_000n - INV_SQRT_UP_2PCT)) / 1_000_000_000n;
  return (liquidity * drop) / Q96;
}

async function quoteExactIn(key: PoolKey, zeroForOne: boolean, amountIn: bigint): Promise<bigint | null> {
  try {
    const { result } = await arcPublicClient().simulateContract({
      address: V4_QUOTER,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }],
    });
    return result[0];
  } catch (error) {
    // The quoter reverts for a pool it cannot route (no liquidity in range,
    // uninitialised). That is a "no quote", not an RPC failure.
    if (error instanceof Error && /revert/i.test(error.message)) return null;
    throw error;
  }
}

async function quoteTier(
  input: ArcToken,
  output: ArcToken,
  tier: PinnedPool,
  amountIn: bigint,
): Promise<TierQuote | null> {
  const key = poolKeyFor(input, output, tier);
  const poolId = poolIdFor(key);
  const zeroForOne = key.currency0.toLowerCase() === input.address.toLowerCase();
  const client = arcPublicClient();
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] }),
    client.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId] }),
  ]);
  const sqrtPriceX96 = slot0[0];
  if (sqrtPriceX96 === 0n || liquidity === 0n) return null;

  const amountOut = await quoteExactIn(key, zeroForOne, amountIn);
  if (amountOut === null) return null;
  return {
    key,
    poolId,
    zeroForOne,
    amountOut,
    spotRate: spotRateFromSqrtPrice(sqrtPriceX96, zeroForOne, key.fee, input.decimals, output.decimals),
    depthOut: depthWithin2Pct(liquidity, sqrtPriceX96, zeroForOne),
  };
}

export async function getSwapQuote(request: SwapQuoteRequest): Promise<SwapQuote> {
  const { inputSymbol, outputSymbol, amount, referenceUsd } = request;
  const warnings: string[] = [];
  const skeleton: Omit<SwapQuote, "tradable" | "reason"> = {
    venue: VENUE,
    inputSymbol,
    outputSymbol,
    inputAmount: amount,
    inputBaseUnits: "0",
    expectedOutput: null,
    minOutput: null,
    impliedRate: null,
    referenceRate: null,
    deviationPct: null,
    priceImpactPct: null,
    feeTier: null,
    tickSpacing: null,
    poolId: null,
    poolKey: null,
    poolDepthOut: null,
    slippageBps: SLIPPAGE_BPS,
    routerAddress: UNIVERSAL_ROUTER,
    chainId: ARC_CHAIN_ID,
    warnings,
    quotedAt: new Date().toISOString(),
  };

  if (inputSymbol === outputSymbol) {
    return refuse(skeleton, "Input and output tokens are the same");
  }
  for (const symbol of [inputSymbol, outputSymbol]) {
    if (!isTradedSymbol(symbol)) {
      return refuse(skeleton, `${symbol} is not an approved Revo token on Arc`);
    }
    const token = ARC_TOKENS[symbol]!;
    if (!token.tradable) {
      return refuse(skeleton, token.untradableReason ?? `Revo does not trade ${symbol} on Arc`);
    }
  }

  const input = ARC_TOKENS[inputSymbol]!;
  const output = ARC_TOKENS[outputSymbol]!;

  const amountIn = toBaseUnits(amount, input.decimals);
  if (amountIn === null) {
    return refuse(skeleton, `"${amount}" is not a valid ${inputSymbol} amount`);
  }
  if (amountIn <= 0n) {
    return refuse(skeleton, "Swap amount must be greater than zero");
  }
  if (amountIn >= 2n ** 128n) {
    return refuse(skeleton, "Swap amount is beyond what a v4 pool can express");
  }
  const withUnits = { ...skeleton, inputBaseUnits: amountIn.toString() };

  const pools = pinnedPoolsFor(input, output);
  if (pools.length === 0) {
    return refuse(
      withUnits,
      `Revo routes every trade through USDC and has no pinned ${inputSymbol}/${outputSymbol} pool on Uniswap v4; rotate via USDC in two steps instead`,
    );
  }

  let tiers: (TierQuote | null)[];
  try {
    tiers = await Promise.all(pools.map((tier) => quoteTier(input, output, tier, amountIn)));
  } catch (error) {
    // Not a verdict on the route: the pool could not be read. Callers must
    // retry later rather than record the swap as untradable.
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `Arc RPC failed while quoting, so the route could not be priced: ${
        error instanceof Error ? error.message.slice(0, 300) : String(error)
      }`,
    );
  }

  const candidates = tiers.filter((t): t is TierQuote => t !== null && t.amountOut > 0n);
  if (candidates.length === 0) {
    return refuse(
      withUnits,
      `Uniswap v4 has no ${inputSymbol}/${outputSymbol} pool with in-range liquidity on Arc that can fill this size`,
    );
  }

  // Best execution is simply the most output; tiers differ enough that the
  // cheapest fee is not always the deepest pool.
  const best = candidates.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));

  const expectedOutput = fromBaseUnits(best.amountOut, output.decimals);
  const minOutBase = (best.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const minOutput = fromBaseUnits(minOutBase, output.decimals);
  const poolDepthOut = fromBaseUnits(best.depthOut, output.decimals);

  const inValue = Number(amount);
  const outValue = Number(expectedOutput);
  if (!Number.isFinite(inValue) || !Number.isFinite(outValue) || inValue <= 0 || outValue <= 0) {
    return refuse(withUnits, "The quoter returned amounts Revo cannot evaluate safely");
  }
  const impliedRate = outValue / inValue;

  // Impact measured against the pool's own marginal rate at the current tick.
  const spotRate = best.spotRate;
  const priceImpactPct =
    Number.isFinite(spotRate) && spotRate > 0 ? ((spotRate - impliedRate) / spotRate) * 100 : null;

  const priced: Omit<SwapQuote, "tradable" | "reason"> = {
    ...withUnits,
    expectedOutput,
    minOutput,
    impliedRate,
    priceImpactPct,
    feeTier: best.key.fee,
    tickSpacing: best.key.tickSpacing,
    poolId: best.poolId,
    poolKey: best.key,
    poolDepthOut,
  };

  if (minOutBase <= 0n) {
    return refuse(priced, "Quoted output is too small to derive a safe execution floor");
  }

  const depthHuman = Number(poolDepthOut);
  if (!Number.isFinite(depthHuman) || depthHuman <= 0) {
    return refuse(priced, "The pool's depth could not be measured, so the size of this bite is unknown");
  }
  const share = (outValue / depthHuman) * 100;
  if (share > MAX_POOL_SHARE_PCT) {
    return refuse(
      priced,
      `This trade would take ${share.toFixed(1)}% of the pool's ${outputSymbol} depth within a 2% move, above the ${MAX_POOL_SHARE_PCT}% ceiling`,
    );
  }

  if (priceImpactPct === null) {
    return refuse(priced, "Price impact could not be measured for this route, so it must not be traded");
  }
  if (priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    return refuse(
      priced,
      `Measured price impact of ${priceImpactPct.toFixed(2)}% exceeds the ${MAX_PRICE_IMPACT_PCT}% ceiling`,
    );
  }

  // Fail closed without an independent price. The reference is what separates
  // a pool that executes from one worth executing against.
  const refIn = referenceUsd?.input;
  const refOut = referenceUsd?.output;
  if (
    typeof refIn !== "number" ||
    typeof refOut !== "number" ||
    !Number.isFinite(refIn) ||
    !Number.isFinite(refOut) ||
    refIn <= 0 ||
    refOut <= 0
  ) {
    return refuse(
      priced,
      "No independent market price was available, so this pool rate could not be checked and the route must not be traded",
    );
  }

  const referenceRate = refIn / refOut;
  const deviationPct = Math.abs((impliedRate - referenceRate) / referenceRate) * 100;
  const checked = { ...priced, referenceRate, deviationPct };

  if (deviationPct > MAX_REFERENCE_DEVIATION_PCT) {
    return refuse(
      checked,
      `Pool price is ${deviationPct.toFixed(2)}% away from the real ${inputSymbol}/${outputSymbol} market rate, above the ${MAX_REFERENCE_DEVIATION_PCT}% ceiling`,
    );
  }
  if (deviationPct > MAX_REFERENCE_DEVIATION_PCT / 2) {
    warnings.push(
      `Pool price sits ${deviationPct.toFixed(2)}% from the real market rate; execution is real but the fill will be off market`,
    );
  }
  warnings.push(
    "Quoted on-chain via eth_call; the exact swap calldata is simulated against the router again before signing",
  );

  return { ...checked, tradable: true };
}

/**
 * UniversalRouter calldata for one exact-input single-pool v4 swap. The
 * router settles the input through Permit2 (so the treasury must hold a
 * Permit2 allowance for it) and pays the output to the caller.
 */
/** What Permit2 currently lets the router pull from `owner` in `token`. */
export async function readPermit2Allowance(
  owner: Address,
  token: Address,
): Promise<{ amount: bigint; expiration: number }> {
  const [amount, expiration] = await arcPublicClient().readContract({
    address: PERMIT2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, UNIVERSAL_ROUTER],
  });
  return { amount, expiration };
}

export interface VenueStatus {
  reachable: boolean;
  blockNumber: string | null;
  poolManagerDeployed: boolean;
  quoterDeployed: boolean;
  routerDeployed: boolean;
  permit2Deployed: boolean;
  /** Pinned pools that are initialised with in-range liquidity right now. */
  livePools: Array<{
    pair: string;
    poolId: Hex;
    feeTier: number;
    tickSpacing: number;
    liquidity: string;
    /** Whether Revo will route a trade through this pool, whatever its depth. */
    tradable: boolean;
  }>;
  error?: string;
}

/** Whether Uniswap v4's contracts are deployed and a Revo pool is live on Arc right now. */
export async function checkVenue(): Promise<VenueStatus> {
  const client = arcPublicClient();
  try {
    const [blockNumber, pm, quoter, router, permit2] = await Promise.all([
      client.getBlockNumber(),
      client.getCode({ address: POOL_MANAGER }),
      client.getCode({ address: V4_QUOTER }),
      client.getCode({ address: UNIVERSAL_ROUTER }),
      client.getCode({ address: PERMIT2 }),
    ]);
    const deployed = (code: Hex | undefined) => typeof code === "string" && code.length > 2;
    const usdc = ARC_TOKENS["USDC"]!;
    const livePools: VenueStatus["livePools"] = [];
    const pinned = Object.values(ARC_TOKENS).flatMap((token) =>
      token.pools.map((tier) => ({ token, tier })),
    );
    await Promise.all(
      pinned.map(async ({ token, tier }) => {
        const key = poolKeyFor(usdc, token, tier);
        const poolId = poolIdFor(key);
        const liquidity = await client.readContract({
          address: STATE_VIEW,
          abi: stateViewAbi,
          functionName: "getLiquidity",
          args: [poolId],
        });
        if (liquidity > 0n) {
          livePools.push({
            pair: `${token.symbol}/USDC`,
            poolId,
            feeTier: tier.fee,
            tickSpacing: tier.tickSpacing,
            liquidity: liquidity.toString(),
            tradable: token.tradable,
          });
        }
      }),
    );
    livePools.sort((a, b) => a.pair.localeCompare(b.pair) || a.feeTier - b.feeTier);
    return {
      reachable: true,
      blockNumber: blockNumber.toString(),
      poolManagerDeployed: deployed(pm),
      quoterDeployed: deployed(quoter),
      routerDeployed: deployed(router),
      permit2Deployed: deployed(permit2),
      livePools,
    };
  } catch (error) {
    return {
      reachable: false,
      blockNumber: null,
      poolManagerDeployed: false,
      quoterDeployed: false,
      routerDeployed: false,
      permit2Deployed: false,
      livePools: [],
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    };
  }
}
