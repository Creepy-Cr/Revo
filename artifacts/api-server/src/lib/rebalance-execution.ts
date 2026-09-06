/**
 * Settlement for an approved rebalance.
 *
 * Approving a rebalance used to validate the targets, mark the book at
 * current prices, and stop. Composition is read from the custody wallet, so
 * that combination produced a proposal reading `executed` beside a position
 * that had not moved. This module is the missing half: it turns an approved
 * target into a real Synthra swap signed by the treasury's own custody key.
 *
 * The order of operations is the safety property, so it is fixed here rather
 * than left to callers:
 *
 *   1. Size the trade from the wallet's LIVE balances, never from the
 *      dashboard the proposal was drafted against.
 *   2. Quote it through `getSynthraQuote`, which refuses on measured price
 *      impact, deviation from the real market rate, and pool share. An
 *      untradable quote ends the attempt; nothing is signed.
 *   3. Simulate every transaction with `eth_call` first. A revert there costs
 *      nothing and definitively means no key was used.
 *   4. Approve the router for exactly the input amount, and only then sign
 *      the swap.
 *   5. Once the swap has confirmed, read the wallet again and record what
 *      actually came back. A swap may fill anywhere between its floor and its
 *      quote, so intent alone does not describe where the book landed. This
 *      step is measurement only: it runs past the point of no return, so it
 *      can report "not known" but can never change the outcome.
 *
 * Outcomes are deliberately three-way rather than throw/return. "refused"
 * means nothing of the treasury's value moved and the proposal must stay
 * actionable. "uncertain" means a signed swap may still land, so the caller
 * must NOT hand the proposal back for a second approval. Collapsing those two
 * into one error would either strand a real trade or invite a double spend.
 *
 * Because settlement outlives the request that started it, the caller can
 * pass a `SwapBroadcastClaim`: it records the swap hash before the mempool
 * sees it and can veto the send, which is what makes an interrupted
 * settlement recoverable by a reconciler without re-sending anything.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import type { AllocationTarget } from "@workspace/db";
import {
  ChainError,
  EXPLORER_URL,
  USDC_ADDRESS,
  broadcastSignedTransfer,
  confirmTransfer,
  encodeApproval,
  ensureTreasuryWallet,
  gasReserveMicroUsdc,
  readAllowance,
  signCustodyCall,
  simulateCustodyCall,
  withCustodyLock,
  type CustodyTransaction,
} from "./arc-chain";
import { ARC_TOKENS, type ArcToken } from "./arc-tokens";
import { readCustodyHoldings, type Holding } from "./holdings";
import { referencePriceFor, type MarketQuote } from "./market";
import { SYNTHRA_ROUTER, getSynthraQuote, type SynthraQuote } from "./synthra";
import { fromBaseUnits, toBaseUnits } from "./tower";
import { logger } from "./logger";

/**
 * Gas budget reserved before a USDC sale is sized. Arc settles gas in USDC
 * out of the same balance the swap spends, so a trade sized at the whole
 * balance always reverts. Covers an approval plus a single-hop v3 swap with
 * room to spare; over-reserving costs a fraction of a cent, under-reserving
 * costs the trade.
 */
const GAS_BUDGET_UNITS = 400_000n;

/**
 * Synthra's router is a SwapRouter02 fork: `exactInputSingle` takes no
 * deadline (confirmed by selector against the deployed bytecode - the
 * original v3 SwapRouter signature is absent). Getting this wrong would
 * decode into a different function entirely, so it is pinned rather than
 * assumed from the Uniswap version the fork descends from.
 */
const swapRouterAbi = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        type: "tuple",
        name: "params",
        components: [
          { type: "address", name: "tokenIn" },
          { type: "address", name: "tokenOut" },
          { type: "uint24", name: "fee" },
          { type: "address", name: "recipient" },
          { type: "uint256", name: "amountIn" },
          { type: "uint256", name: "amountOutMinimum" },
          { type: "uint160", name: "sqrtPriceLimitX96" },
        ],
      },
    ],
    outputs: [{ type: "uint256", name: "amountOut" }],
  },
] as const;

/** One line of the treasury's composition, read back after a swap settled. */
export interface RealisedHolding {
  symbol: string;
  /** Exact human units held, at the token's own precision. */
  units: string;
  /**
   * Share of the book by USD value. Null when the whole book could not be
   * valued: a percentage computed over a partly-priced book is wrong in a way
   * that reads as a real position, so it is withheld rather than estimated.
   */
  percentage: number | null;
}

/**
 * What a rebalance actually achieved, measured from the wallet after its swap
 * confirmed - as opposed to what it aimed for, which is the quote.
 *
 * Every field is nullable on purpose. This is measurement after the fact: the
 * trade has already landed, so a chain that cannot be read has to come back as
 * "not known". A failed read is never a zero fill and never an empty treasury.
 */
export interface RealisedOutcome {
  /**
   * Output token actually received, measured as the wallet's balance change
   * across the swap. Null when it could not be measured.
   */
  realisedOutput: string | null;
  /**
   * Realised slippage against the quote, in percent. Positive means the fill
   * came in below the quoted output (the usual direction), negative means it
   * beat the quote. A run of these drifting toward the floor is what pool
   * depth deteriorating looks like from here.
   */
  realisedSlippagePct: number | null;
  /** Composition after the swap. Empty when the chain could not be re-read. */
  holdingsAfter: RealisedHolding[];
  /** Why the figures above are missing, unqualified, or carry a caveat. */
  realisedNote?: string;
}

export interface SwapSettlement extends RealisedOutcome {
  txHash: string;
  explorerUrl: string;
  inputSymbol: string;
  outputSymbol: string;
  /** Human amount actually sent into the pool. */
  amountIn: string;
  /** Quoted output at signing time. */
  expectedOutput: string;
  /** The floor the swap was signed against. */
  minOutput: string;
  feeTier: number;
  /** Present only when this rebalance had to raise the router's allowance. */
  approvalTxHash?: string;
}

export type RebalanceOutcome =
  /** A swap confirmed on Arc. The proposal may now read as executed. */
  | { kind: "settled"; settlement: SwapSettlement }
  /** Live balances already satisfy the target; no transaction was needed. */
  | { kind: "nothing-to-do"; reason: string }
  /** Nothing of value moved. The proposal must stay actionable. */
  | { kind: "refused"; reason: string; txHash?: string }
  /** A signed swap may still land. The proposal must NOT be re-offered. */
  | { kind: "uncertain"; reason: string; txHash?: string };

/**
 * Last gate before the swap reaches the mempool.
 *
 * Called with the swap's deterministic hash after signing and immediately
 * BEFORE broadcast, on the custody lock's own database client so the caller's
 * write is durable before anything can land. That ordering is what lets a
 * reconciler read a settlement it did not start: a claim recorded with no
 * hash proves no swap was ever sent, so it can be recovered without risking a
 * second trade.
 *
 * Returning false means the caller no longer owns this settlement - something
 * else resolved the proposal while the swap was being prepared - and the
 * signed payload is discarded unsent. Nothing was broadcast, so no nonce is
 * consumed and the treasury's position is untouched.
 */
export type SwapBroadcastClaim = (
  hash: Hex,
  executor: CustodyTransaction,
) => Promise<boolean>;

/** One direction of trade, already sized against real spendable balance. */
interface SwapLeg {
  input: ArcToken;
  output: ArcToken;
  /** Human decimal string, exact at the input token's precision. */
  amount: string;
  amountBaseUnits: bigint;
  /** USD notional being rotated, for the audit trail. */
  notionalUsd: number;
}

type PlanResult =
  | {
      kind: "swap";
      leg: SwapLeg;
      /**
       * Output-token balance the wallet held when the trade was sized, in base
       * units. The realised fill is measured against this, so it is carried
       * out of the planner rather than re-read later - by then the swap has
       * already moved it.
       */
      outputHeldBefore: bigint;
    }
  | { kind: "nothing-to-do"; reason: string }
  | { kind: "refused"; reason: string };

/** Smallest trade Synthra's quoter can price meaningfully: 0.01 of a token. */
function dustFloor(token: ArcToken): bigint {
  return token.decimals >= 2 ? 10n ** BigInt(token.decimals - 2) : 1n;
}

/**
 * Sizes the single swap that moves the treasury furthest toward its approved
 * target, using the balances the wallet holds right now.
 *
 * One swap rather than a full basket rotation on purpose: the only pair Revo
 * can route on Arc is USDC/EURC, so a target over those two symbols is always
 * reachable in one leg, and every extra leg is another way for a rebalance to
 * half-settle.
 */
async function planSwap(
  treasuryId: string,
  targets: AllocationTarget[],
  quote: MarketQuote | null,
): Promise<PlanResult> {
  const custody = await readCustodyHoldings(treasuryId);
  if (!custody.ok) {
    return {
      kind: "refused",
      reason: `Arc could not be read (${custody.error ?? "RPC unreachable"}), so the rebalance could not be sized against real balances.`,
    };
  }

  // Every held asset must be priceable, including the ones no target names:
  // percentages are shares of the whole book, so an unpriced holding makes
  // the denominator wrong and would systematically oversize the trade.
  const priced = new Map<string, { holding: Holding; usd: number; price: number }>();
  for (const holding of custody.holdings) {
    const price = referencePriceFor(holding.coingeckoId, quote);
    if (price === undefined) {
      if (holding.units > 0) {
        return {
          kind: "refused",
          reason: `No independent market price for ${holding.symbol}, so the treasury's composition could not be valued and the rebalance was not sized.`,
        };
      }
      continue;
    }
    priced.set(holding.symbol, { holding, usd: holding.units * price, price });
  }

  const totalUsd = [...priced.values()].reduce((sum, p) => sum + p.usd, 0);
  if (!(totalUsd > 0)) {
    return {
      kind: "refused",
      reason:
        "The custody wallet holds nothing on Arc, so there is no position to rebalance. Fund the treasury and approve again.",
    };
  }

  // Positive delta = the target wants more of this asset than is held.
  const deltas = targets
    .map((target) => {
      const entry = priced.get(target.symbol);
      if (!entry) return null;
      return {
        symbol: target.symbol,
        token: ARC_TOKENS[target.symbol]!,
        entry,
        deltaUsd: (totalUsd * target.percentage) / 100 - entry.usd,
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null && d.token.tradable);

  const sell = deltas.reduce<(typeof deltas)[number] | null>(
    (worst, d) => (d.deltaUsd < 0 && (!worst || d.deltaUsd < worst.deltaUsd) ? d : worst),
    null,
  );
  const buy = deltas.reduce<(typeof deltas)[number] | null>(
    (best, d) => (d.deltaUsd > 0 && (!best || d.deltaUsd > best.deltaUsd) ? d : best),
    null,
  );
  if (!sell || !buy) {
    return {
      kind: "nothing-to-do",
      reason: "Live balances already sit on the approved target, so no swap was needed.",
    };
  }

  const notionalUsd = Math.min(-sell.deltaUsd, buy.deltaUsd);
  const wanted = toBaseUnits(
    (notionalUsd / sell.entry.price).toFixed(sell.token.decimals),
    sell.token.decimals,
  );
  if (wanted === null || wanted <= 0n) {
    return {
      kind: "nothing-to-do",
      reason: `The remaining drift is smaller than one ${sell.symbol} unit, so no swap was needed.`,
    };
  }

  // Spendable, not held. Gas on Arc comes out of the USDC balance being sent,
  // so selling the full balance reverts at estimation every time.
  let spendable = BigInt(sell.entry.holding.raw);
  if (sell.symbol === "USDC") {
    let reserve: bigint;
    try {
      reserve = await gasReserveMicroUsdc(GAS_BUDGET_UNITS);
    } catch (error) {
      return {
        kind: "refused",
        reason:
          error instanceof ChainError
            ? error.message
            : "Arc gas prices could not be read, so no spendable USDC balance could be derived.",
      };
    }
    spendable -= reserve;
  }
  if (spendable <= 0n) {
    return {
      kind: "refused",
      reason: `The wallet's ${sell.symbol} balance is fully consumed by the gas reserve, so no amount can be swapped.`,
    };
  }

  const amountBaseUnits = wanted < spendable ? wanted : spendable;
  if (amountBaseUnits < dustFloor(sell.token)) {
    return {
      kind: "nothing-to-do",
      reason: `The remaining drift is under 0.01 ${sell.symbol}, below the smallest amount Synthra can price, so no swap was sent.`,
    };
  }

  return {
    kind: "swap",
    leg: {
      input: sell.token,
      output: buy.token,
      amount: fromBaseUnits(amountBaseUnits, sell.token.decimals),
      amountBaseUnits,
      notionalUsd: Number(fromBaseUnits(amountBaseUnits, sell.token.decimals)) * sell.entry.price,
    },
    outputHeldBefore: BigInt(buy.entry.holding.raw),
  };
}

/** Whether Arc bills this token's balance for gas, which is USDC and only USDC. */
function isGasAsset(token: ArcToken): boolean {
  return token.address.toLowerCase() === USDC_ADDRESS.toLowerCase();
}

/** Joins a short list into prose: "a", "a and b", "a, b and c". */
function listSentence(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Renders a composition for an operator: "500.01 USDC (54.1%) and 424.1 EURC (45.9%)". */
export function describeHoldings(holdings: RealisedHolding[]): string {
  return listSentence(
    holdings.map((h) =>
      h.percentage === null ? `${h.units} ${h.symbol}` : `${h.units} ${h.symbol} (${h.percentage}%)`,
    ),
  );
}

/** The fill being measured, when a realised amount is being read back. */
interface FillMeasurement {
  token: ArcToken;
  /** Output-token balance before the swap, in base units. */
  heldBefore: bigint;
  /** Quoted output the fill is judged against. */
  expectedOutput: string;
}

/**
 * Reads back what the treasury actually holds once a swap has confirmed, and
 * how much of the output token really arrived.
 *
 * This runs AFTER the point of no return, so it is reporting and never
 * control flow. It cannot throw and it cannot fail a settlement: the swap has
 * confirmed either way, and the only honest thing to do with an unreadable
 * chain is to say the realised figures are unknown. Reporting a failed read
 * as a zero fill would turn a good trade into an apparent total loss.
 */
export async function readSettledOutcome(
  treasuryId: string,
  marketQuote: MarketQuote | null,
  fill?: FillMeasurement,
): Promise<RealisedOutcome> {
  const unknown = (note: string): RealisedOutcome => ({
    realisedOutput: null,
    realisedSlippagePct: null,
    holdingsAfter: [],
    realisedNote: note,
  });

  try {
    const custody = await readCustodyHoldings(treasuryId);
    if (!custody.ok) {
      return unknown(
        `Holdings could not be re-read after the swap confirmed (${custody.error ?? "Arc RPC unreachable"}), so what the treasury now holds is unknown rather than unchanged.`,
      );
    }

    const notes: string[] = [];
    const held = custody.holdings.filter((h) => h.units > 0);
    const priced = held.map((h) => ({
      holding: h,
      price: referencePriceFor(h.coingeckoId, marketQuote),
    }));
    const unpriced = priced.filter((p) => p.price === undefined);
    const totalUsd = priced.reduce((sum, p) => sum + p.holding.units * (p.price ?? 0), 0);
    // Same rule as the dashboard's valuation gate: a split derived from a
    // partly-priced book understates whatever could not be valued, which
    // reads as a position the treasury does not have.
    const splitKnown = unpriced.length === 0 && totalUsd > 0;
    if (held.length > 0 && !splitKnown) {
      notes.push(
        unpriced.length > 0
          ? `No reference price for ${unpriced.map((p) => p.holding.symbol).join(", ")}, so the post-trade split is reported in units only.`
          : "The book could not be valued, so the post-trade split is reported in units only.",
      );
    }

    const holdingsAfter: RealisedHolding[] = priced.map((p) => ({
      symbol: p.holding.symbol,
      units: fromBaseUnits(BigInt(p.holding.raw), p.holding.decimals),
      percentage: splitKnown
        ? Math.round(((p.holding.units * (p.price ?? 0)) / totalUsd) * 1000) / 10
        : null,
    }));

    if (!fill) {
      return {
        realisedOutput: null,
        realisedSlippagePct: null,
        holdingsAfter,
        ...(notes.length > 0 ? { realisedNote: notes.join(" ") } : {}),
      };
    }

    const after = custody.holdings.find((h) => h.symbol === fill.token.symbol);
    const received = after === undefined ? null : BigInt(after.raw) - fill.heldBefore;
    if (received === null || received <= 0n) {
      notes.push(
        `The wallet's ${fill.token.symbol} balance did not rise across the swap, so the amount actually received could not be measured from balances.`,
      );
      return {
        realisedOutput: null,
        realisedSlippagePct: null,
        holdingsAfter,
        realisedNote: notes.join(" "),
      };
    }

    const realisedOutput = fromBaseUnits(received, fill.token.decimals);
    const expected = Number(fill.expectedOutput);
    const realised = Number(realisedOutput);
    const realisedSlippagePct =
      Number.isFinite(expected) && expected > 0 && Number.isFinite(realised)
        ? Math.round(((expected - realised) / expected) * 100_000) / 1000
        : null;

    if (isGasAsset(fill.token)) {
      // Arc settles gas in USDC out of this very balance, so the measured
      // delta is the fill minus this rebalance's gas. Small, but it is a real
      // bias and an operator comparing fills deserves to know it is there.
      notes.push(
        `The received figure is the wallet's ${fill.token.symbol} balance change, so it is net of the Arc gas this rebalance paid in ${fill.token.symbol}.`,
      );
    }

    return {
      realisedOutput,
      realisedSlippagePct,
      holdingsAfter,
      ...(notes.length > 0 ? { realisedNote: notes.join(" ") } : {}),
    };
  } catch (error) {
    return unknown(
      `Holdings could not be re-read after the swap confirmed (${
        error instanceof Error ? error.message : "Arc RPC unreachable"
      }), so what the treasury now holds is unknown rather than unchanged.`,
    );
  }
}

function encodeSwap(leg: SwapLeg, recipient: string, feeTier: number, minOut: bigint): Hex {
  return encodeFunctionData({
    abi: swapRouterAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: leg.input.address,
        tokenOut: leg.output.address,
        fee: feeTier,
        recipient: recipient as Address,
        amountIn: leg.amountBaseUnits,
        amountOutMinimum: minOut,
        // No price limit: `amountOutMinimum` is the protection, and it is
        // derived locally from a measured spot quote rather than asked for.
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

/** Maps a chain failure onto whether the treasury's value can still move. */
function classify(error: unknown, stage: string, txHash?: string): RebalanceOutcome {
  if (error instanceof ChainError) {
    if (error.code === "SEND_UNCERTAIN") {
      return { kind: "uncertain", reason: error.message, ...(txHash ? { txHash } : {}) };
    }
    return { kind: "refused", reason: error.message, ...(txHash ? { txHash } : {}) };
  }
  return {
    kind: "refused",
    reason: `The rebalance failed while ${stage} and nothing was settled: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

/**
 * Turns an approved rebalance target into a settled swap on Arc.
 *
 * Never throws for an ordinary on-chain failure: the caller has to record the
 * cause and decide the proposal's status either way, and an unroutable pool or
 * a reverted swap is a normal outcome on a testnet, not an exception.
 */
export async function settleRebalance(
  treasuryId: string,
  targets: AllocationTarget[],
  marketQuote: MarketQuote | null,
  claimBroadcast?: SwapBroadcastClaim,
): Promise<RebalanceOutcome> {
  let plan: PlanResult;
  try {
    plan = await planSwap(treasuryId, targets, marketQuote);
  } catch (error) {
    return classify(error, "sizing the trade");
  }
  if (plan.kind !== "swap") return plan;
  const { leg, outputHeldBefore } = plan;

  // The same guards the operator-facing quote endpoint applies. A route that
  // is too shallow, too far from the real market, or too deep a bite of the
  // pool never reaches a signer.
  const referenceIn = referencePriceFor(leg.input.coingeckoId, marketQuote);
  const referenceOut = referencePriceFor(leg.output.coingeckoId, marketQuote);
  let quote: SynthraQuote;
  try {
    quote = await getSynthraQuote({
      inputSymbol: leg.input.symbol,
      outputSymbol: leg.output.symbol,
      amount: leg.amount,
      ...(referenceIn !== undefined && referenceOut !== undefined
        ? { referenceUsd: { input: referenceIn, output: referenceOut } }
        : {}),
    });
  } catch (error) {
    return classify(error, "quoting the swap");
  }
  if (!quote.tradable || quote.minOutput === null || quote.feeTier === null) {
    return {
      kind: "refused",
      reason: `Synthra could not price a tradable ${leg.input.symbol} to ${leg.output.symbol} swap: ${quote.reason ?? "the route is not tradable"}`,
    };
  }

  const minOut = toBaseUnits(quote.minOutput, leg.output.decimals);
  if (minOut === null || minOut <= 0n) {
    return {
      kind: "refused",
      reason: "The quoted execution floor could not be expressed in base units, so the swap was not signed.",
    };
  }
  const feeTier = quote.feeTier;

  const wallet = await ensureTreasuryWallet(treasuryId);
  const swapData = encodeSwap(leg, wallet.address, feeTier, minOut);

  let approvalTxHash: Hex | undefined;
  let swapHash: Hex | undefined;
  let claimLost = false;

  try {
    // Signing reads the pending nonce from the chain, so the approval and the
    // swap must not interleave with any other custody send for this treasury.
    await withCustodyLock(treasuryId, async (custodyTx) => {
      const allowance = await readAllowance(
        leg.input.address,
        wallet.address,
        SYNTHRA_ROUTER,
      );
      if (allowance < leg.amountBaseUnits) {
        // Exact-amount approval: the router keeps no standing permission over
        // the treasury's balance beyond this one trade.
        const approvalData = encodeApproval(SYNTHRA_ROUTER, leg.amountBaseUnits);
        await simulateCustodyCall(wallet.address, leg.input.address, approvalData);
        const signedApproval = await signCustodyCall(
          wallet,
          leg.input.address,
          approvalData,
          custodyTx,
        );
        approvalTxHash = signedApproval.hash;
        await broadcastSignedTransfer(signedApproval);
        // The approval has to be mined before the swap can be simulated
        // truthfully, so this one waits inside the lock.
        await confirmTransfer(signedApproval.hash);
      }

      // Simulated with the allowance in place, against the real router, at
      // the real size. A revert here blocks the send.
      await simulateCustodyCall(wallet.address, SYNTHRA_ROUTER, swapData);

      const signedSwap = await signCustodyCall(wallet, SYNTHRA_ROUTER, swapData, custodyTx);
      if (claimBroadcast && !(await claimBroadcast(signedSwap.hash, custodyTx))) {
        // The caller's claim is gone, so this swap must not reach the
        // mempool: the signed payload is dropped with no nonce consumed.
        claimLost = true;
        return;
      }
      swapHash = signedSwap.hash;
      await broadcastSignedTransfer(signedSwap);
    });
  } catch (error) {
    // An approval that may or may not have landed moves no value: it only
    // grants the router permission to spend an exact amount that was never
    // spent. Only an uncertain SWAP leaves the treasury's position in doubt.
    const stage = swapHash ? "broadcasting the swap" : "preparing the swap";
    const outcome = classify(error, stage, swapHash);
    if (outcome.kind === "uncertain" && !swapHash) {
      return {
        kind: "refused",
        reason: `${outcome.reason} No swap was signed, so the treasury's position is unchanged.`,
      };
    }
    logger.error(
      { err: error, treasuryId, approvalTxHash, swapHash },
      "Rebalance swap did not settle",
    );
    return outcome;
  }

  if (claimLost) {
    return {
      kind: "refused",
      reason:
        "The rebalance was no longer awaiting settlement when its swap was ready, so the signed swap was discarded unsent and no holdings moved.",
    };
  }

  if (!swapHash) {
    return {
      kind: "refused",
      reason: "Internal error: the swap signing state was lost, so nothing was settled.",
    };
  }

  // Confirmation runs outside the custody lock: the nonce is already
  // committed, and holding the lock for a minute would stall withdrawals.
  try {
    await confirmTransfer(swapHash);
  } catch (error) {
    if (error instanceof ChainError && error.code === "TX_REVERTED") {
      return {
        kind: "refused",
        reason: `The rebalance swap reverted on Arc (tx ${swapHash}), so no holdings moved.`,
        txHash: swapHash,
      };
    }
    return {
      kind: "uncertain",
      reason:
        error instanceof ChainError
          ? error.message
          : `The rebalance swap was broadcast (tx ${swapHash}) but its outcome could not be observed.`,
      txHash: swapHash,
    };
  }

  // The swap is settled from here on. Reading back what it achieved is
  // reporting, so it can degrade to "not known" but must never change the
  // outcome or throw - see `readSettledOutcome`.
  const realised = await readSettledOutcome(treasuryId, marketQuote, {
    token: leg.output,
    heldBefore: outputHeldBefore,
    expectedOutput: quote.expectedOutput ?? "0",
  });

  return {
    kind: "settled",
    settlement: {
      txHash: swapHash,
      explorerUrl: `${EXPLORER_URL}/tx/${swapHash}`,
      inputSymbol: leg.input.symbol,
      outputSymbol: leg.output.symbol,
      amountIn: leg.amount,
      expectedOutput: quote.expectedOutput ?? "0",
      minOutput: quote.minOutput,
      feeTier,
      ...realised,
      ...(approvalTxHash ? { approvalTxHash } : {}),
    },
  };
}
