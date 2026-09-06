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

export interface SwapSettlement {
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
  | { kind: "swap"; leg: SwapLeg }
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
  };
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
  const { leg } = plan;

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
      ...(approvalTxHash ? { approvalTxHash } : {}),
    },
  };
}
