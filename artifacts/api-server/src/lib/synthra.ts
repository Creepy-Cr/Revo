/**
 * Synthra - the real swap venue Revo trades on, read straight off Arc Testnet.
 *
 * Why this exists instead of routing through the Tower aggregator: Tower's
 * public API mangles amounts badly enough that nothing it says about a pool can
 * be trusted. It refuses any fractional input outright, returns zero output for
 * anything under 5000 USDC, and quantises output to whole tokens. All three are
 * artefacts of its own request encoding. Quoting the same pools directly proves
 * it: 0.01 USDC quotes cleanly, output scales linearly, and there is no minimum
 * size. Tower remains useful for one thing only, discovering which venues exist
 * on the chain, and that catalogue is what produced the addresses below.
 *
 * Synthra is a Uniswap v3 fork, so the standard factory/quoter/router shape
 * applies and quoting is an `eth_call` against the quoter rather than a request
 * to anyone's server.
 *
 * Two properties of this chain shape the guards here:
 *
 * 1. Pool prices are detached from real markets, because nothing arbitrages a
 *    testnet. Depth and price sanity are independent problems: a pool can hold
 *    millions and still quote at twice the real rate. Every quote is therefore
 *    checked against an independent reference price and refused without one.
 *
 * 2. Price impact has to be measured, not asked for. The impact figure is
 *    derived here by quoting a dust-sized trade for the spot rate and comparing
 *    the real order against it, which is a number we computed rather than one a
 *    third party asserted.
 *
 * This module quotes and does not sign. Executable amounts still have to be
 * confirmed on-chain before anything is broadcast.
 */

import { createPublicClient, http, type PublicClient } from "viem";
import { arcTestnet, ARC_RPC_URL } from "./arc-chain";
import { ARC_TOKENS, isTradedSymbol, type ArcToken } from "./arc-tokens";
import { toBaseUnits, fromBaseUnits } from "./tower";

/** Synthra deployment on Arc Testnet, from Tower's venue catalogue and verified on-chain. */
export const SYNTHRA_FACTORY = "0x0fB6EEDA6e90E90797083861A75D15752a27f59c" as const;
export const SYNTHRA_ROUTER = "0xA545bCB1Bd7985c59ea162aB1748A0803434C31b" as const;
export const SYNTHRA_QUOTER = "0x3Ce954107b1A675826B33bF23060Dd655e3758fE" as const;

export const ARC_CHAIN_ID = 5042002;

/** Uniswap v3 fee tiers. The 100 tier is not deployed for any pair we trade. */
const FEE_TIERS = [500, 3000, 10000] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Routes quoting worse than this measured impact are refused, not merely flagged. */
const MAX_PRICE_IMPACT_PCT = 5;

/**
 * How far the pool rate may sit from the real-world reference before the quote
 * is refused. Deliberately wide, because testnet pools drift hard; it exists to
 * catch a pool that is broken, not one that is merely unarbitraged.
 */
const MAX_REFERENCE_DEVIATION_PCT = 25;

/** Output above this share of the pool's output-side balance is refused as too deep a bite. */
const MAX_POOL_SHARE_PCT = 10;

/** Slippage tolerance applied to the quoted output to derive an execution floor. */
export const SLIPPAGE_BPS = 50;

const erc20Abi = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const factoryAbi = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }],
    outputs: [{ type: "address" }],
  },
] as const;

/**
 * QuoterV2 is nonpayable on-chain because it reverts to return its result, but
 * `eth_call` ignores mutability. Declaring it view here lets the quote run
 * without a signer or any state change.
 */
const quoterAbi = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "view",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "address", name: "tokenIn" },
          { type: "address", name: "tokenOut" },
          { type: "uint256", name: "amountIn" },
          { type: "uint24", name: "fee" },
          { type: "uint160", name: "sqrtPriceLimitX96" },
        ],
      },
    ],
    outputs: [
      { type: "uint256", name: "amountOut" },
      { type: "uint160", name: "sqrtPriceX96After" },
      { type: "uint32", name: "initializedTicksCrossed" },
      { type: "uint256", name: "gasEstimate" },
    ],
  },
] as const;

let client: PublicClient | null = null;

function rpc(): PublicClient {
  client ??= createPublicClient({
    chain: arcTestnet,
    transport: http(ARC_RPC_URL, { timeout: 15_000 }),
  }) as PublicClient;
  return client;
}

/** Test seam. Drops the cached RPC client. */
export function resetSynthraClient(): void {
  client = null;
}

export interface SynthraQuote {
  venue: "synthra";
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
  feeTier: number | null;
  poolAddress: string | null;
  /** Output-side token balance held by the pool, human units. */
  poolLiquidityOut: string | null;
  slippageBps: number;
  routerAddress: string;
  chainId: number;
  /** False whenever the route must not be signed. `reason` then says why. */
  tradable: boolean;
  reason?: string;
  /** Non-fatal concerns worth showing an operator before they approve. */
  warnings: string[];
  quotedAt: string;
}

export interface SynthraQuoteRequest {
  inputSymbol: string;
  outputSymbol: string;
  /** Human decimal string, e.g. "12.5". Fractions are fine here. */
  amount: string;
  /** Real-world USD prices for both legs. Required: a quote without one is refused. */
  referenceUsd?: { input: number; output: number };
}

interface TierQuote {
  fee: number;
  pool: `0x${string}`;
  amountOut: bigint;
  spotOut: bigint;
  dustIn: bigint;
  reserveOut: bigint;
}

function refuse(
  partial: Omit<SynthraQuote, "tradable" | "reason">,
  reason: string,
): SynthraQuote {
  return { ...partial, tradable: false, reason };
}

/** Dust trade used to establish the pool's spot rate: 0.01 of the input token. */
function dustAmount(token: ArcToken): bigint {
  return token.decimals >= 2 ? 10n ** BigInt(token.decimals - 2) : 1n;
}

async function quoteTier(
  input: ArcToken,
  output: ArcToken,
  fee: number,
  amountIn: bigint,
): Promise<TierQuote | null> {
  const c = rpc();
  let pool: string;
  try {
    pool = (await c.readContract({
      address: SYNTHRA_FACTORY,
      abi: factoryAbi,
      functionName: "getPool",
      args: [input.address, output.address, fee],
    })) as string;
  } catch {
    return null;
  }
  if (!pool || pool === ZERO_ADDRESS) return null;
  const poolAddress = pool as `0x${string}`;

  const dustIn = dustAmount(input);
  const ask = (amount: bigint) =>
    c.readContract({
      address: SYNTHRA_QUOTER,
      abi: quoterAbi,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: input.address,
          tokenOut: output.address,
          amountIn: amount,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }) as Promise<readonly [bigint, bigint, number, bigint]>;

  try {
    const [main, spot, reserveOut] = await Promise.all([
      ask(amountIn),
      ask(dustIn),
      c.readContract({
        address: output.address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [poolAddress],
      }) as Promise<bigint>,
    ]);
    return { fee, pool: poolAddress, amountOut: main[0], spotOut: spot[0], dustIn, reserveOut };
  } catch {
    // A pool that exists but cannot quote this size is simply not a candidate.
    return null;
  }
}

/**
 * Price a swap against Synthra's pools.
 *
 * Always resolves. A route that cannot be traded comes back with
 * `tradable: false` and a reason rather than as a thrown error: the caller has
 * to render the cause either way, and an unusable route is an ordinary outcome
 * on a testnet, not an exception.
 */
export async function getSynthraQuote(request: SynthraQuoteRequest): Promise<SynthraQuote> {
  const { inputSymbol, outputSymbol, amount, referenceUsd } = request;
  const warnings: string[] = [];
  const skeleton: Omit<SynthraQuote, "tradable" | "reason"> = {
    venue: "synthra",
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
    poolAddress: null,
    poolLiquidityOut: null,
    slippageBps: SLIPPAGE_BPS,
    routerAddress: SYNTHRA_ROUTER,
    chainId: ARC_CHAIN_ID,
    warnings,
    quotedAt: new Date().toISOString(),
  };

  if (inputSymbol === outputSymbol) {
    return refuse(skeleton, "Input and output tokens are the same");
  }
  for (const symbol of [inputSymbol, outputSymbol]) {
    if (!isTradedSymbol(symbol)) {
      return refuse(skeleton, `${symbol} is not an approved Revo token on Arc Testnet`);
    }
    const token = ARC_TOKENS[symbol]!;
    if (!token.tradable) {
      return refuse(
        skeleton,
        token.untradableReason ?? `Revo does not trade ${symbol} on Arc Testnet`,
      );
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
  const withUnits = { ...skeleton, inputBaseUnits: amountIn.toString() };

  let tiers: (TierQuote | null)[];
  try {
    tiers = await Promise.all(FEE_TIERS.map((fee) => quoteTier(input, output, fee, amountIn)));
  } catch (error) {
    return refuse(
      withUnits,
      error instanceof Error ? `Arc RPC failed while quoting: ${error.message}` : "Arc RPC failed while quoting",
    );
  }

  const candidates = tiers.filter((t): t is TierQuote => t !== null && t.amountOut > 0n);
  if (candidates.length === 0) {
    const anyPool = tiers.some((t) => t !== null);
    return refuse(
      withUnits,
      anyPool
        ? `Synthra has a ${inputSymbol}/${outputSymbol} pool but it quoted zero output at this size`
        : `Synthra has no ${inputSymbol}/${outputSymbol} pool on Arc Testnet`,
    );
  }

  // Best execution is simply the most output; fee tiers differ enough here that
  // the cheapest tier is not always the deepest.
  const best = candidates.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));

  const expectedOutput = fromBaseUnits(best.amountOut, output.decimals);
  const minOutBase = (best.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const minOutput = fromBaseUnits(minOutBase, output.decimals);
  const poolLiquidityOut = fromBaseUnits(best.reserveOut, output.decimals);

  const inValue = Number(amount);
  const outValue = Number(expectedOutput);
  if (!Number.isFinite(inValue) || !Number.isFinite(outValue) || inValue <= 0 || outValue <= 0) {
    return refuse(withUnits, "Synthra returned amounts Revo cannot evaluate safely");
  }
  const impliedRate = outValue / inValue;

  // Impact measured against the pool's own dust-sized spot rate.
  const dustInHuman = Number(fromBaseUnits(best.dustIn, input.decimals));
  const dustOutHuman = Number(fromBaseUnits(best.spotOut, output.decimals));
  const spotRate = dustInHuman > 0 && dustOutHuman > 0 ? dustOutHuman / dustInHuman : null;
  const priceImpactPct =
    spotRate !== null && spotRate > 0 ? ((spotRate - impliedRate) / spotRate) * 100 : null;

  const priced: Omit<SynthraQuote, "tradable" | "reason"> = {
    ...withUnits,
    expectedOutput,
    minOutput,
    impliedRate,
    priceImpactPct,
    feeTier: best.fee,
    poolAddress: best.pool,
    poolLiquidityOut,
  };

  if (minOutBase <= 0n) {
    return refuse(priced, "Quoted output is too small to derive a safe execution floor");
  }

  const reserveOutHuman = Number(poolLiquidityOut);
  if (Number.isFinite(reserveOutHuman) && reserveOutHuman > 0) {
    const share = (outValue / reserveOutHuman) * 100;
    if (share > MAX_POOL_SHARE_PCT) {
      return refuse(
        priced,
        `This trade would take ${share.toFixed(1)}% of the pool's ${outputSymbol}, above the ${MAX_POOL_SHARE_PCT}% ceiling`,
      );
    }
  }

  if (priceImpactPct !== null && priceImpactPct > MAX_PRICE_IMPACT_PCT) {
    return refuse(
      priced,
      `Measured price impact of ${priceImpactPct.toFixed(2)}% exceeds the ${MAX_PRICE_IMPACT_PCT}% ceiling`,
    );
  }

  // Fail closed without an independent price. Arc's pools are detached enough
  // from real markets that this comparison is the only thing separating a route
  // that merely executes from one worth executing.
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
      `Pool price is ${deviationPct.toFixed(0)}% away from the real ${inputSymbol}/${outputSymbol} market rate, so this quote is not economically meaningful`,
    );
  }
  if (deviationPct > MAX_REFERENCE_DEVIATION_PCT / 2) {
    warnings.push(
      `Pool price sits ${deviationPct.toFixed(1)}% from the real market rate, so execution is real but the rate is not a market rate`,
    );
  }
  if (priceImpactPct === null) {
    warnings.push("Price impact could not be measured for this route");
  }
  warnings.push(
    "Quoted on-chain via eth_call; the transaction must still be simulated against the router before signing",
  );

  return { ...checked, tradable: true };
}

/** Whether Synthra's contracts are actually deployed and answering on Arc right now. */
export async function checkSynthraVenue(): Promise<{
  reachable: boolean;
  factoryDeployed: boolean;
  quoterDeployed: boolean;
  routerDeployed: boolean;
  blockNumber: string | null;
  error?: string;
}> {
  try {
    const c = rpc();
    const [block, factory, quoter, router] = await Promise.all([
      c.getBlockNumber(),
      c.getBytecode({ address: SYNTHRA_FACTORY }),
      c.getBytecode({ address: SYNTHRA_QUOTER }),
      c.getBytecode({ address: SYNTHRA_ROUTER }),
    ]);
    const has = (code: string | undefined) => Boolean(code && code !== "0x");
    return {
      reachable: true,
      factoryDeployed: has(factory),
      quoterDeployed: has(quoter),
      routerDeployed: has(router),
      blockNumber: block.toString(),
    };
  } catch (error) {
    return {
      reachable: false,
      factoryDeployed: false,
      quoterDeployed: false,
      routerDeployed: false,
      blockNumber: null,
      error: error instanceof Error ? error.message : "Arc RPC unreachable",
    };
  }
}
