/**
 * Settlement for an approved rebalance.
 *
 * Approving a rebalance used to validate the targets, mark the book at
 * current prices, and stop. Composition is read from the custody wallet, so
 * that combination produced a proposal reading `executed` beside a position
 * that had not moved. This module is the missing half: it turns an approved
 * target into a real Uniswap v4 swap signed by the treasury's own custody key.
 *
 * The order of operations is the safety property, so it is fixed here rather
 * than left to callers:
 *
 *   1. Size the trade from the wallet's LIVE balances, never from the
 *      dashboard the proposal was drafted against.
 *   2. Quote it through `getSwapQuote`, which refuses on measured price
 *      impact, deviation from the real market rate, and pool share. An
 *      untradable quote ends the attempt; nothing is signed.
 *   3. Simulate every transaction with `eth_call` first. A revert there costs
 *      nothing and definitively means no key was used.
 *   4. Approve the router for exactly the input amount, and only then sign
 *      the swap.
 *   5. Once the swap has confirmed, take the fill out of its receipt and read
 *      the wallet again for the composition it produced. A swap may fill
 *      anywhere between its floor and its quote, so intent alone does not
 *      describe where the book landed. This step is measurement only: it runs
 *      past the point of no return, so it can report "not known" but can
 *      never change the outcome.
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
import type { AllocationTarget } from "@workspace/db";
import {
  ChainError,
  EXPLORER_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
  broadcastSignedTransfer,
  confirmTransfer,
  creditedByReceipt,
  encodeApproval,
  ensureTreasuryWallet,
  gasCostMicroUsdc,
  gasReserveMicroUsdc,
  getConfirmedReceipt,
  readAllowance,
  signCustodyCall,
  simulateCustodyCall,
  withCustodyLock,
  type ConfirmedReceipt,
  type CustodyTransaction,
} from "./arc-chain";
import { ARC_TOKENS, priceIdOf, tradableRiskTokens, type ArcToken } from "./arc-tokens";
import { readCustodyHoldings, type Holding } from "./holdings";
import { referenceEntryFor, referencePriceFor, type MarketQuote } from "./market";
import {
  PERMIT2,
  SWAP_DEADLINE_SECONDS,
  UNIVERSAL_ROUTER,
  encodePermit2Approval,
  encodeV4Swap,
  getSwapQuote,
  readPermit2Allowance,
  type SwapQuote,
} from "./uniswap-v4";
import { fromBaseUnits, toBaseUnits } from "./tower";
import { logger } from "./logger";
import {
  REBALANCE_SIGNED_AUDIT_ACTION,
  assertFreshMarketQuote,
  isCurrentReference,
  assertIssuerAllows,
  assertRebalanceCaps,
} from "./custody-policy";
import { auditSafe, recordAudit } from "./audit";

/**
 * Gas budget reserved before a USDC sale is sized. Arc settles gas in USDC
 * out of the same balance the swap spends, so a trade sized at the whole
 * balance always reverts. Covers an approval plus a single-hop v3 swap with
 * room to spare; over-reserving costs a fraction of a cent, under-reserving
 * costs the trade.
 */
const GAS_BUDGET_UNITS = 400_000n;


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
   * Output token actually received: the exact amount the swap's receipt shows
   * the router paying into the custody wallet, falling back to the wallet's
   * balance change across the swap when the receipt carries no such transfer.
   * Null when neither could be measured.
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
  /**
   * What this rebalance paid Arc in gas, in USDC: the swap plus the allowance
   * approval it had to send first, since both come out of the treasury's own
   * balance. Null when it could not be read from the receipts, which is "not
   * known" and never "free".
   */
  gasCostUsdc: string | null;
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
export interface SwapLeg {
  input: ArcToken;
  output: ArcToken;
  /** Human decimal string, exact at the input token's precision. */
  amount: string;
  amountBaseUnits: bigint;
  /** USD notional being rotated, for the audit trail. */
  notionalUsd: number;
}

export type PlanResult =
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

/**
 * Smallest leg worth sending, in USD. Below this the gas and the pool fee
 * are the trade. Measured in value rather than token units because 0.01 of
 * a token is a cent of wARS and a thousand dollars of cirBTC.
 */
export const MIN_LEG_USD = 1;

/**
 * Plans the next leg toward a target without quoting, signing or sending
 * anything. Settlement uses it after a leg confirms to learn whether the
 * approved target is now reached or another leg is still owed, so the
 * proposal's record says which - the alternative was calling a target
 * "executed" after the first of several swaps.
 */
export async function planRebalanceLeg(
  treasuryId: string,
  targets: AllocationTarget[],
  quote: MarketQuote | null,
): Promise<PlanResult> {
  return planSwap(treasuryId, targets, quote);
}

/**
 * Sizes the single swap that moves the treasury furthest toward its approved
 * target, using the balances the wallet holds right now.
 *
 * One swap rather than a full basket rotation on purpose: every pool Revo
 * pins on Arc has USDC on one side, so every leg it can route is either a
 * sale of a risk asset into USDC or a purchase of one with USDC, and every
 * extra leg is another way for a rebalance to half-settle. A target that
 * moves value between two risk assets is reached over two approvals: the
 * sale first, because reducing exposure never needs the reserve to fund it.
 *
 * Purchases are funded only from USDC the target says is surplus. The
 * reserve floor is a share of the book, and a purchase that dipped below it
 * to chase another asset's target would be a policy breach made by the
 * engine that exists to prevent them.
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

  // Every held asset must carry a CURRENT price, including the ones no
  // target names: percentages are shares of the whole book, so a holding
  // priced from a stale or missing feed makes the denominator wrong and would
  // systematically mis-size the trade. Zero balances need no price.
  const priced = new Map<string, { holding: Holding; usd: number; price: number }>();
  for (const holding of custody.holdings) {
    const entry = referenceEntryFor(holding.priceId, quote);
    const current = entry !== undefined && isCurrentReference(entry);
    if (!current && holding.units > 0) {
      return {
        kind: "refused",
        reason:
          entry === undefined
            ? `No independent market price for ${holding.symbol}, so the treasury's composition could not be valued and the rebalance was not sized.`
            : `The independent market price for ${holding.symbol} is stale or more than 10 minutes old, so the treasury's composition could not be valued and the rebalance was not sized.`,
      };
    }
    // A zero balance is worth nothing whatever its price says, and it stays
    // in the plan so a purchase of it can still be sized; the leg's own
    // freshness check then rules on that price before anything is quoted.
    priced.set(holding.symbol, {
      holding,
      usd: current ? holding.units * entry.usd : 0,
      price: entry?.usd ?? Number.NaN,
    });
  }

  const totalUsd = [...priced.values()].reduce((sum, p) => sum + p.usd, 0);
  if (!(totalUsd > 0)) {
    return {
      kind: "refused",
      reason:
        "The custody wallet holds nothing on Arc, so there is no position to rebalance. Fund the treasury and approve again.",
    };
  }

  const usdcEntry = priced.get("USDC");
  if (!usdcEntry) {
    return {
      kind: "refused",
      reason: "USDC could not be priced, so no leg through the reserve could be sized.",
    };
  }

  // Held-only positions are fixed at whatever they are worth right now: Revo
  // never trades them, so no target can move them. The approved percentages
  // are applied to the rest of the book, scaled so they still add up to it.
  // Whether or not the approval named the held-only asset, and however its
  // price has drifted since, the tradable targets stay reachable.
  const heldOnlyUsd = [...priced.values()]
    .filter((p) => !p.holding.tradable)
    .reduce((sum, p) => sum + p.usd, 0);
  const tradableUsd = totalUsd - heldOnlyUsd;
  if (!(tradableUsd > 0)) {
    return {
      kind: "nothing-to-do",
      reason: `Everything the wallet holds is in positions Revo never trades (${[...priced.values()]
        .filter((p) => !p.holding.tradable && p.usd > 0)
        .map((p) => p.holding.symbol)
        .join(", ")}), so there is nothing to rebalance.`,
    };
  }

  // Percentages are shares of the tradable book: a tradable risk asset the
  // targets do not name is implicitly targeted at zero, since the named
  // targets already account for the whole and leave it nothing.
  const targetPct = new Map<string, number>();
  for (const t of targets) {
    if (ARC_TOKENS[t.symbol]?.tradable) targetPct.set(t.symbol, t.percentage);
  }
  for (const token of tradableRiskTokens()) {
    if (!targetPct.has(token.symbol)) targetPct.set(token.symbol, 0);
  }
  const targetTotalPct = [...targetPct.values()].reduce((sum, p) => sum + p, 0);
  if (!(targetTotalPct > 0)) {
    return {
      kind: "refused",
      reason: "The approved targets give the tradable book nothing to hold, so no leg could be sized.",
    };
  }

  // Positive delta = the target wants more of this asset than is held.
  const deltaOf = (symbol: string): number | null => {
    const entry = priced.get(symbol);
    const pct = targetPct.get(symbol);
    if (!entry || pct === undefined) return null;
    return (tradableUsd * pct) / targetTotalPct - entry.usd;
  };
  const usdcDelta = deltaOf("USDC") ?? 0;
  const usdcSurplusUsd = Math.max(0, -usdcDelta);

  type Leg = { sell: ArcToken; buy: ArcToken; notionalUsd: number };
  const legs: Leg[] = [];
  for (const token of tradableRiskTokens()) {
    const delta = deltaOf(token.symbol);
    if (delta === null) continue;
    if (delta < 0) {
      legs.push({ sell: token, buy: ARC_TOKENS.USDC!, notionalUsd: -delta });
    } else if (delta > 0 && usdcSurplusUsd > 0) {
      legs.push({ sell: ARC_TOKENS.USDC!, buy: token, notionalUsd: Math.min(delta, usdcSurplusUsd) });
    }
  }
  const chosen = legs.reduce<Leg | null>(
    (best, leg) => (!best || leg.notionalUsd > best.notionalUsd ? leg : best),
    null,
  );
  if (!chosen) {
    const heldOnlyNames = [...priced.values()]
      .filter((p) => !p.holding.tradable && p.usd > 0)
      .map((p) => p.holding.symbol);
    return {
      kind: "nothing-to-do",
      reason:
        heldOnlyNames.length > 0
          ? `The tradable balances already sit on the approved target; ${heldOnlyNames.join(", ")} is held at its current share because Revo never trades it, so no swap was needed.`
          : "Live balances already sit on the approved target, so no swap was needed.",
    };
  }

  const sell = { symbol: chosen.sell.symbol, token: chosen.sell, entry: priced.get(chosen.sell.symbol)! };
  const buy = { symbol: chosen.buy.symbol, token: chosen.buy, entry: priced.get(chosen.buy.symbol)! };
  if (!Number.isFinite(sell.entry.price) || sell.entry.price <= 0) {
    // Unreachable while a sale needs a positive, currently priced balance,
    // and kept so a future change to that rule cannot divide by nothing.
    return {
      kind: "refused",
      reason: `No current independent market price for ${sell.symbol}, so the sale could not be sized.`,
    };
  }
  const wanted = toBaseUnits(
    (chosen.notionalUsd / sell.entry.price).toFixed(sell.token.decimals),
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
  const amount = fromBaseUnits(amountBaseUnits, sell.token.decimals);
  const notionalUsd = Number(amount) * sell.entry.price;
  if (amountBaseUnits <= 0n || notionalUsd < MIN_LEG_USD) {
    return {
      kind: "nothing-to-do",
      reason: `The remaining drift is under $${MIN_LEG_USD} of ${sell.symbol}, too small to be worth a swap, so none was sent.`,
    };
  }

  return {
    kind: "swap",
    leg: {
      input: sell.token,
      output: buy.token,
      amount,
      amountBaseUnits,
      notionalUsd,
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

/**
 * The fill being measured, when a realised amount is being read back.
 *
 * Two independent sources, in preference order. `credited` is what the swap's
 * own transfer logs say the router paid out - exact, gross of the gas Arc
 * bills to a USDC balance, and still readable long after the trade. The
 * balance delta measures the same thing indirectly and is distorted by both
 * of those, so it is the fallback rather than the primary evidence.
 */
export interface FillMeasurement {
  token: ArcToken;
  /** Exact output credited by the swap receipt, in base units. Null when unreadable. */
  credited?: bigint | null;
  /** Output-token balance before the swap, in base units. Absent once it is gone. */
  heldBefore?: bigint | null;
  /** Quoted output the fill is judged against. Absent when the quote is not known. */
  expectedOutput?: string | null;
}

/**
 * Realised slippage against the quote, in percent. Null whenever either side
 * is unusable, which includes a fill recovered without the quote it was
 * signed against.
 */
function slippagePct(expectedOutput: string | null | undefined, realisedOutput: string): number | null {
  const expected = Number(expectedOutput ?? Number.NaN);
  const realised = Number(realisedOutput);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(realised)) return null;
  return Math.round(((expected - realised) / expected) * 100_000) / 1000;
}

/**
 * The output leg of a swap that has already confirmed, read back from its
 * receipt: which pinned token the router paid into the custody wallet, and
 * exactly how much of it.
 *
 * This is what lets a rebalance recovered long after its settlement died
 * still report a fill. The pre-trade balance it would otherwise be measured
 * against is gone, but the transfer that paid it out stays in the receipt.
 *
 * Null whenever the receipt says nothing unambiguous - unreadable, no credit
 * to the wallet, or more than one token credited, which is not a shape this
 * settlement produces and so is not a thing to guess between. Reporting, not
 * control flow: it never throws.
 */
export async function readFillFromReceipt(
  treasuryId: string,
  txHash: Hex,
): Promise<FillMeasurement | null> {
  try {
    const [wallet, receipt] = await Promise.all([
      ensureTreasuryWallet(treasuryId),
      getConfirmedReceipt(txHash),
    ]);
    if (!wallet || !receipt) return null;
    const credits = Object.values(ARC_TOKENS)
      .map((token) => ({
        token,
        credited: creditedByReceipt(receipt, token.address, wallet.address),
      }))
      .filter((credit): credit is { token: ArcToken; credited: bigint } => credit.credited !== null);
    const only = credits.length === 1 ? credits[0] : undefined;
    return only ? { token: only.token, credited: only.credited } : null;
  } catch (error) {
    logger.warn(
      { err: error, treasuryId, txHash },
      "Realised fill could not be read from the swap receipt",
    );
    return null;
  }
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
  // A fill taken from the receipt does not depend on the holdings read, so an
  // unreadable chain hides where the book landed without also hiding what the
  // swap returned.
  const unknown = (note: string): RealisedOutcome => {
    const credited = fill?.credited ?? null;
    if (!fill || credited === null || credited <= 0n) {
      return { realisedOutput: null, realisedSlippagePct: null, holdingsAfter: [], realisedNote: note };
    }
    const realisedOutput = fromBaseUnits(credited, fill.token.decimals);
    return {
      realisedOutput,
      realisedSlippagePct: slippagePct(fill.expectedOutput, realisedOutput),
      holdingsAfter: [],
      realisedNote: note,
    };
  };

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
      price: referencePriceFor(h.priceId, marketQuote),
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

    // The receipt first: it is the amount the router actually paid out. The
    // balance delta only stands in when the receipt carried no such transfer.
    const fromReceipt = fill.credited ?? null;
    const heldBefore = fill.heldBefore ?? null;
    const after = custody.holdings.find((h) => h.symbol === fill.token.symbol);
    const delta = heldBefore === null || after === undefined ? null : BigInt(after.raw) - heldBefore;
    const fromBalance = delta !== null && delta > 0n ? delta : null;
    const received = fromReceipt ?? fromBalance;
    if (received === null) {
      notes.push(
        heldBefore === null
          ? `The swap's receipt showed no ${fill.token.symbol} arriving in the custody wallet, so the amount actually received could not be measured.`
          : `The swap's receipt showed no ${fill.token.symbol} arriving in the custody wallet and the wallet's ${fill.token.symbol} balance did not rise across the swap, so the amount actually received could not be measured.`,
      );
      return {
        realisedOutput: null,
        realisedSlippagePct: null,
        holdingsAfter,
        realisedNote: notes.join(" "),
      };
    }

    const realisedOutput = fromBaseUnits(received, fill.token.decimals);

    if (fromReceipt === null && isGasAsset(fill.token)) {
      // Only the balance delta carries this bias: Arc settles gas in USDC out
      // of the very balance being measured, so the difference is the fill
      // minus this rebalance's gas. A figure taken from the transfer log is
      // gross of it, and the caveat is dropped rather than restated.
      notes.push(
        `The received figure is the wallet's ${fill.token.symbol} balance change, so it is net of the Arc gas this rebalance paid in ${fill.token.symbol}.`,
      );
    }

    return {
      realisedOutput,
      realisedSlippagePct: slippagePct(fill.expectedOutput, realisedOutput),
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

/**
 * What a rebalance's transactions cost the treasury in gas, in USDC.
 *
 * Every leg is counted, because Arc bills each one to the treasury's own USDC
 * balance: the swap and, when the router had to be allowed first, the
 * approval. A leg whose gas could not be read makes the whole figure unknown
 * rather than smaller, since a partial sum presented as the cost understates
 * it exactly the way a zero would.
 */
function totalGasUsdc(receipts: (ConfirmedReceipt | undefined)[]): string | null {
  let totalMicro = 0n;
  for (const receipt of receipts) {
    const micro = gasCostMicroUsdc(receipt);
    if (micro === null) return null;
    totalMicro += micro;
  }
  return fromBaseUnits(totalMicro, USDC_DECIMALS);
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
 * a reverted swap is an ordinary outcome, not an exception.
 */
export async function settleRebalance(
  treasuryId: string,
  targets: AllocationTarget[],
  marketQuote: MarketQuote | null,
  claimBroadcast?: SwapBroadcastClaim,
): Promise<RebalanceOutcome> {
  try {
    // The anchor price must be current before anything is sized; the two
    // prices the chosen leg depends on are checked once the leg is known.
    assertFreshMarketQuote(marketQuote, [priceIdOf(ARC_TOKENS.USDC!.price)]);
  } catch (error) {
    logger.error({ err: error, treasuryId }, "Rebalance refused by market price policy");
    await auditSafe({
      treasuryId,
      action: "custody.rebalance",
      actorRole: "system",
      result: "refused",
      reason: error instanceof Error ? error.message : String(error),
    });
    return classify(error, "checking the independent market price");
  }
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
  // The leg is known now, so the freshness rule is applied to the two prices
  // this trade actually depends on rather than to the whole feed.
  const legPriceIds = [priceIdOf(leg.input.price), priceIdOf(leg.output.price)];
  try {
    assertFreshMarketQuote(marketQuote, legPriceIds);
  } catch (error) {
    return classify(error, "checking the independent market price");
  }
  const referenceIn = referencePriceFor(priceIdOf(leg.input.price), marketQuote);
  const referenceOut = referencePriceFor(priceIdOf(leg.output.price), marketQuote);
  let quote: SwapQuote;
  try {
    quote = await getSwapQuote({
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
  if (
    !quote.tradable ||
    quote.minOutput === null ||
    quote.feeTier === null ||
    quote.poolKey === null
  ) {
    return {
      kind: "refused",
      reason: `Uniswap v4 could not price a tradable ${leg.input.symbol} to ${leg.output.symbol} swap: ${quote.reason ?? "the route is not tradable"}`,
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
  const poolKey = quote.poolKey;

  const wallet = await ensureTreasuryWallet(treasuryId);

  let approvalTxHash: Hex | undefined;
  /** Kept for their gas: the approvals are part of what this rebalance cost. */
  const approvalReceipts: ConfirmedReceipt[] = [];
  let swapHash: Hex | undefined;
  let claimLost = false;
  let tradeUsd = 0;

  /**
   * Signs, broadcasts and waits for one preparatory transaction inside the
   * custody lock. Each one has to be mined before the next step can be
   * simulated truthfully, so they wait here rather than racing the swap.
   */
  const sendAndConfirm = async (
    custodyTx: CustodyTransaction,
    to: Address,
    data: Hex,
  ): Promise<void> => {
    await simulateCustodyCall(wallet.address, to, data);
    const signed = await signCustodyCall(wallet, to, data, custodyTx);
    approvalTxHash = signed.hash;
    await broadcastSignedTransfer(signed);
    approvalReceipts.push(await confirmTransfer(signed.hash));
  };

  try {
    // Signing reads the pending nonce from the chain, so the approvals and
    // the swap must not interleave with any other custody send for this
    // treasury.
    await withCustodyLock(treasuryId, async (custodyTx) => {
      const tradePrice = referencePriceFor(priceIdOf(leg.input.price), marketQuote);
      if (tradePrice === undefined) {
        throw new ChainError(
          "REFUSED_BY_POLICY",
          `A current independent ${leg.input.symbol} price is required before signing.`,
        );
      }
      tradeUsd = Number(leg.amount) * tradePrice;
      await assertRebalanceCaps(treasuryId, tradeUsd, custodyTx);
      await assertIssuerAllows(
        leg.input.address,
        wallet.address as Address,
      );
      await assertIssuerAllows(
        leg.output.address,
        wallet.address as Address,
      );

      // The router pulls the input through Permit2, so two exact-amount
      // permissions are needed and neither outlives this trade: the token's
      // allowance to Permit2, and Permit2's allowance to the router, which
      // also expires with the swap deadline.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const deadline = BigInt(nowSeconds + SWAP_DEADLINE_SECONDS);

      // Exact means exact: an allowance left larger than this trade (by an
      // earlier swap that never spent it) is rewritten down, not reused.
      const tokenAllowance = await readAllowance(leg.input.address, wallet.address, PERMIT2);
      if (tokenAllowance !== leg.amountBaseUnits) {
        await sendAndConfirm(
          custodyTx,
          leg.input.address,
          encodeApproval(PERMIT2, leg.amountBaseUnits),
        );
      }

      const permit = await readPermit2Allowance(wallet.address as Address, leg.input.address);
      if (permit.amount !== leg.amountBaseUnits || BigInt(permit.expiration) <= deadline) {
        await sendAndConfirm(
          custodyTx,
          PERMIT2,
          encodePermit2Approval(leg.input.address, leg.amountBaseUnits, Number(deadline)),
        );
      }

      const swapData = encodeV4Swap({
        key: poolKey,
        input: leg.input.address,
        output: leg.output.address,
        amountIn: leg.amountBaseUnits,
        minOut,
        deadline,
      });

      // Simulated with the allowances in place, against the real router, at
      // the real size. A revert here blocks the send.
      await simulateCustodyCall(wallet.address, UNIVERSAL_ROUTER, swapData);

      // The approvals above waited for confirmations. The independent price
      // that justified this trade is checked again at the moment of signing,
      // not only when settlement began.
      assertFreshMarketQuote(marketQuote, legPriceIds);

      const signedSwap = await signCustodyCall(wallet, UNIVERSAL_ROUTER, swapData, custodyTx);
      if (claimBroadcast && !(await claimBroadcast(signedSwap.hash, custodyTx))) {
        // The caller's claim is gone, so this swap must not reach the
        // mempool: the signed payload is dropped with no nonce consumed.
        claimLost = true;
        return;
      }
      // The value this swap commits is written to the audit chain before the
      // mempool sees it, so the rolling cap counts it even if the receipt is
      // never learned. A failed write stops the send: the claim then names a
      // hash that never broadcast, which the reconciler resolves as missing.
      await recordAudit({
        treasuryId,
        action: REBALANCE_SIGNED_AUDIT_ACTION,
        actorRole: "system",
        result: "ok",
        reason: "Swap signed and claimed; broadcasting to Arc.",
        detail: { txHash: signedSwap.hash, inputSymbol: leg.input.symbol, amountIn: leg.amount, tradeUsd },
      });
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
    if (
      error instanceof ChainError &&
      (error.code === "REFUSED_BY_POLICY" || error.code === "PAUSED")
    ) {
      await auditSafe({
        treasuryId,
        action: "custody.rebalance",
        actorRole: "system",
        result: "refused",
        reason: error.message,
        detail: { inputSymbol: leg.input.symbol, amountIn: leg.amount },
      });
    }
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
  let receipt: ConfirmedReceipt | undefined;
  try {
    receipt = await confirmTransfer(swapHash);
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
    // Exactly what the router paid out, straight from the confirmed receipt.
    // Never throws, so a receipt that cannot be parsed simply leaves the
    // balance delta below to measure the fill as it always did.
    credited: creditedByReceipt(receipt, leg.output.address, wallet.address),
    heldBefore: outputHeldBefore,
    expectedOutput: quote.expectedOutput ?? "0",
  });

  await auditSafe({
    treasuryId,
    action: "custody.rebalance.executed",
    actorRole: "system",
    result: "ok",
    reason: "The rebalance swap confirmed on Arc.",
    detail: {
      txHash: swapHash,
      inputSymbol: leg.input.symbol,
      amountIn: leg.amount,
      tradeUsd,
    },
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
      // Straight out of the receipts already in hand, so what the trading
      // itself took out of the treasury is on the record beside the fill.
      gasCostUsdc: totalGasUsdc([...approvalReceipts, receipt]),
      ...realised,
      ...(approvalTxHash ? { approvalTxHash } : {}),
    },
  };
}
