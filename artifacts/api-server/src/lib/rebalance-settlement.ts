/**
 * Lifecycle of an approved rebalance proposal, from claim to terminal state.
 *
 * Approval and settlement are deliberately separated. Approving claims the
 * proposal ("approved") and returns; settling is a chain round trip - quote,
 * simulate, approve, sign, broadcast, confirm - that measured around ten
 * seconds on a healthy Arc and has no upper bound under congestion. Holding
 * an HTTP request open across it hands the operator a dead connection while
 * money is genuinely moving, so settlement runs in the background and the
 * console watches the proposal instead.
 *
 * That split is only safe because a settlement can be picked up by something
 * other than the process that started it:
 *
 *   - The swap hash is written BEFORE the swap is broadcast, guarded on the
 *     proposal still being "approved". So an "approved" row with no hash
 *     proves nothing was ever sent, and one with a hash names exactly the
 *     transaction whose receipt decides the outcome.
 *   - That same pre-broadcast write is the settlement's claim. If it finds
 *     the proposal already resolved, the signed swap is discarded unsent -
 *     a reconciler and a live settlement can never both send.
 *   - Every status write is guarded on "approved", and the operator-facing
 *     activity is logged only when that write actually claimed the row, so
 *     two instances reconciling at once produce one resolution and one log.
 *
 * Reconciliation therefore only ever reads receipts. It never signs and never
 * re-sends, which is what makes it safe to run on several instances.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import {
  alertsTable,
  db,
  treasuryProposalsTable,
  type TreasuryProposal,
} from "@workspace/db";
import { getTransferRecoveryStatus, type CustodyTransaction } from "./arc-chain";
import { raiseAlert } from "./alerts";
import { auditSafe } from "./audit";
import { logger } from "./logger";
import { getMarketQuote, type MarketQuote } from "./market";
import {
  describeHoldings,
  readFillFromReceipt,
  readSettledOutcome,
  settleRebalance,
  type SwapSettlement,
} from "./rebalance-execution";
import { logActivity } from "./state";

/**
 * How long a settlement started elsewhere is left alone before its recorded
 * transaction is probed. Comfortably longer than a live confirmation wait, so
 * the reconciler resolves abandoned work rather than racing healthy work.
 */
const SETTLEMENT_GRACE_MS = 120_000;

/**
 * How long a claim may sit with NO transaction hash before it is handed back
 * to the operator. The hash is always persisted before broadcast, so a null
 * hash already proves nothing was sent; this window exists only so the
 * reconciler does not disturb a settlement still working towards its first
 * signature (that path re-checks the claim before broadcasting, which closes
 * the race completely).
 */
const NO_BROADCAST_RECOVERY_MS = 5 * 60_000;

/**
 * How long a broadcast transaction the node has never heard of is probed
 * before an operator is asked to look. It cannot be resolved automatically:
 * re-sending is forbidden, and calling it failed would risk reporting a trade
 * as unwound while its swap could still be sitting in someone's mempool.
 */
const MISSING_TX_REVIEW_MS = 30 * 60_000;

const MANUAL_REVIEW_ALERT = "rebalance.manual-review";

export type SettlementResult =
  /**
   * Present only when THIS call settled a swap on Arc: it carries the realised
   * fill, so the audit trail records what the rebalance achieved rather than
   * only what it intended. Absent when no swap was needed at all.
   */
  | { kind: "executed"; proposal: TreasuryProposal; settlement?: SwapSettlement }
  | { kind: "unsettled"; proposal: TreasuryProposal; error: string };

type ProposalWrite = Partial<typeof treasuryProposalsTable.$inferInsert>;

/**
 * Status write guarded on the proposal still being an unresolved claim.
 * Returns the updated row only when this caller won it, which is what every
 * activity log and audit event in this module is gated on.
 */
async function writeIfStillApproved(
  treasuryId: string,
  proposalId: string,
  values: ProposalWrite,
): Promise<TreasuryProposal | undefined> {
  const [updated] = await db
    .update(treasuryProposalsTable)
    .set(values)
    .where(
      and(
        eq(treasuryProposalsTable.id, proposalId),
        eq(treasuryProposalsTable.treasuryId, treasuryId),
        eq(treasuryProposalsTable.status, "approved"),
      ),
    )
    .returning();
  return updated;
}

/**
 * The operator-facing account of a settled rebalance.
 *
 * A settlement used to be described purely as intent - what was sent, what
 * the quote expected, what floor it was signed against - so "executed" beside
 * a 50/50 target said nothing about where the book actually landed. A swap
 * may legitimately fill anywhere between the floor and the quote, so the
 * realised fill and the composition it produced lead here, and the quote is
 * kept beside them as the thing being measured against.
 *
 * The gas sits with them, because Arc bills it in USDC out of the treasury's
 * own balance: it is money this rebalance spent, and reporting the fill gross
 * of it would otherwise leave it invisible.
 *
 * When a read failed, the entry says so in as many words. It never falls back
 * to reporting the quote as though it were the fill, and never reports gas it
 * could not read as nothing paid.
 */
function describeSettlement(settlement: SwapSettlement, action: string): string {
  const tier = `${settlement.feeTier / 10_000}% tier`;
  const parts: string[] = [];
  const realisedSlippagePct = settlement.realisedSlippagePct ?? null;
  const holdingsAfter = settlement.holdingsAfter ?? [];

  if ((settlement.realisedOutput ?? null) === null) {
    parts.push(
      `Swapped ${settlement.amountIn} ${settlement.inputSymbol} on Synthra (${tier}) against a quote of ${settlement.expectedOutput} ${settlement.outputSymbol}, with a floor of ${settlement.minOutput} ${settlement.outputSymbol}.`,
    );
  } else {
    parts.push(
      `Swapped ${settlement.amountIn} ${settlement.inputSymbol} and received ${settlement.realisedOutput} ${settlement.outputSymbol} on Synthra (${tier}), against a quote of ${settlement.expectedOutput} and a floor of ${settlement.minOutput} ${settlement.outputSymbol}.`,
    );
    if (realisedSlippagePct !== null) {
      const magnitude = Math.abs(realisedSlippagePct).toFixed(2);
      parts.push(
        realisedSlippagePct >= 0
          ? `Realised slippage was ${magnitude}% below the quote.`
          : `The fill beat the quote by ${magnitude}%.`,
      );
    }
  }

  const gasCostUsdc = settlement.gasCostUsdc ?? null;
  parts.push(
    gasCostUsdc === null
      ? "The Arc gas this rebalance paid could not be read from its receipt, so what it cost is not known."
      : `Arc gas for this rebalance cost ${gasCostUsdc} USDC, taken from the treasury's own balance.`,
  );

  if (holdingsAfter.length > 0) {
    parts.push(`The treasury now holds ${describeHoldings(holdingsAfter)}.`);
  }
  if (settlement.realisedNote) parts.push(settlement.realisedNote);
  parts.push(`Target: ${action}.`);
  return parts.join(" ");
}

/**
 * Records the swap hash on the custody lock's own client, before broadcast.
 * A false return means the claim is gone and the swap must not be sent.
 */
async function claimBroadcast(
  treasuryId: string,
  proposalId: string,
  hash: Hex,
  executor: CustodyTransaction,
): Promise<boolean> {
  const [claimed] = await executor
    .update(treasuryProposalsTable)
    .set({ executionTxHash: hash })
    .where(
      and(
        eq(treasuryProposalsTable.id, proposalId),
        eq(treasuryProposalsTable.treasuryId, treasuryId),
        eq(treasuryProposalsTable.status, "approved"),
      ),
    )
    .returning({ id: treasuryProposalsTable.id });
  return claimed !== undefined;
}

/**
 * Drives one approved proposal to its real terminal state by settling the
 * rebalance on Arc.
 *
 * Three outcomes, three different obligations:
 *   - settled / nothing-to-do: the target is genuinely reached, so "executed".
 *   - refused: no value moved, so the proposal goes back to "pending" and the
 *     operator can act on it again.
 *   - uncertain: a signed swap may still land, so it stays "approved" with
 *     its hash recorded, and the reconciler resolves it from the receipt.
 *     Handing it back for a second approval could double the trade.
 */
export async function settleApprovedProposal(
  treasuryId: string,
  proposal: TreasuryProposal,
  quote: MarketQuote | null,
): Promise<SettlementResult> {
  const targets = proposal.targetAllocations;
  if (!targets || targets.length === 0) {
    const executed = await writeIfStillApproved(treasuryId, proposal.id, {
      status: "executed",
      decidedAt: new Date(),
    });
    if (executed) {
      await logActivity(
        treasuryId,
        `Proposal "${proposal.title}" approved`,
        "Approved with no allocation targets attached, so no swap was required and no holdings moved.",
        "executed",
        "system",
      );
    }
    return { kind: "executed", proposal: executed ?? proposal };
  }

  const outcome = await settleRebalance(treasuryId, targets, quote, (hash, executor) =>
    claimBroadcast(treasuryId, proposal.id, hash, executor),
  );

  if (outcome.kind === "settled") {
    const { settlement } = outcome;
    const executed = await writeIfStillApproved(treasuryId, proposal.id, {
      status: "executed",
      decidedAt: new Date(),
      executionTxHash: settlement.txHash,
    });
    if (executed) {
      await logActivity(
        treasuryId,
        "Rebalance settled on Arc",
        describeSettlement(settlement, proposal.action),
        "executed",
        "onchain",
        settlement.txHash,
      );
    }
    return { kind: "executed", proposal: executed ?? proposal, settlement };
  }

  if (outcome.kind === "nothing-to-do") {
    const executed = await writeIfStillApproved(treasuryId, proposal.id, {
      status: "executed",
      decidedAt: new Date(),
    });
    if (executed) {
      await logActivity(
        treasuryId,
        "Rebalance needed no swap",
        `${outcome.reason} Target: ${proposal.action}.`,
        "executed",
        "system",
      );
    }
    return { kind: "executed", proposal: executed ?? proposal };
  }

  if (outcome.kind === "uncertain") {
    // Stays "approved" on purpose. The hash is already recorded (the claim
    // wrote it before broadcast), so the reconciler owns this one now.
    await logActivity(
      treasuryId,
      "Rebalance swap outcome unresolved",
      `${outcome.reason} The proposal stays approved, not executed, until its transaction is read from the chain. It will not be offered for approval again, and reconciliation will resolve it.`,
      "failed",
      outcome.txHash ? "onchain" : "system",
      outcome.txHash ?? null,
    );
    const [current] = await db
      .select()
      .from(treasuryProposalsTable)
      .where(
        and(
          eq(treasuryProposalsTable.id, proposal.id),
          eq(treasuryProposalsTable.treasuryId, treasuryId),
        ),
      );
    return { kind: "unsettled", proposal: current ?? proposal, error: outcome.reason };
  }

  // Refused: nothing of the treasury's value moved, so the operator gets the
  // proposal back. Any hash is kept as the record of the attempt that failed.
  const returned = await writeIfStillApproved(treasuryId, proposal.id, {
    status: "pending",
    decidedAt: null,
    ...(outcome.txHash ? { executionTxHash: outcome.txHash } : {}),
  });
  if (returned) {
    await logActivity(
      treasuryId,
      "Rebalance did not settle",
      `${outcome.reason} No holdings moved, so the proposal is actionable again.`,
      "failed",
      outcome.txHash ? "onchain" : "system",
      outcome.txHash ?? null,
    );
  }
  return {
    kind: "unsettled",
    proposal: returned ?? proposal,
    error: outcome.reason,
  };
}

/** Settlements this process started, so tests and shutdown can await them. */
const inFlight = new Set<Promise<void>>();

/**
 * Starts settling a freshly claimed proposal WITHOUT blocking the caller's
 * request. Failures are logged, never thrown: the claim is already durable,
 * and anything this attempt leaves unresolved is the reconciler's job.
 */
export function startProposalSettlement(
  treasuryId: string,
  proposal: TreasuryProposal,
  quote: MarketQuote | null,
): void {
  const task = settleApprovedProposal(treasuryId, proposal, quote)
    .then(async (settled) => {
      await auditSafe({
        action: "proposal.settle",
        actorWallet: null,
        treasuryId,
        resourceId: proposal.id,
        result: settled.kind === "executed" ? "ok" : "failed",
        ...(settled.kind === "unsettled" ? { reason: settled.error } : {}),
        detail: {
          status: settled.proposal.status,
          txHash: settled.proposal.executionTxHash,
          // Intent and outcome side by side: a run of fills drifting toward
          // the floor is only visible if each one is recorded.
          ...(settled.kind === "executed" && settled.settlement
            ? {
                expectedOutput: settled.settlement.expectedOutput,
                minOutput: settled.settlement.minOutput,
                realisedOutput: settled.settlement.realisedOutput,
                realisedSlippagePct: settled.settlement.realisedSlippagePct,
                // What the trade itself cost the treasury, beside what it
                // achieved. Null is "not known", never "nothing paid".
                gasCostUsdc: settled.settlement.gasCostUsdc ?? null,
              }
            : {}),
        },
      });
      if (settled.kind === "unsettled") {
        logger.warn(
          { treasuryId, proposalId: proposal.id, status: settled.proposal.status, reason: settled.error },
          "Approved rebalance did not settle on Arc",
        );
      } else {
        logger.info(
          { treasuryId, proposalId: proposal.id, txHash: settled.proposal.executionTxHash },
          "Approved rebalance settled on Arc",
        );
      }
    })
    .catch((error) => {
      // The proposal is left exactly as the failure found it; reconciliation
      // reads the chain and decides, rather than guessing here.
      logger.error(
        { err: error, treasuryId, proposalId: proposal.id },
        "Background rebalance settlement threw",
      );
    })
    .finally(() => {
      inFlight.delete(task);
    });
  inFlight.add(task);
}

/** Awaits every background settlement this process started. */
export async function drainProposalSettlements(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

/** One alert per stranded proposal, however many times it is probed. */
async function alreadyFlaggedForReview(proposalId: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: alertsTable.id })
    .from(alertsTable)
    .where(
      and(
        eq(alertsTable.kind, MANUAL_REVIEW_ALERT),
        sql`${alertsTable.data}->>'proposalId' = ${proposalId}`,
      ),
    )
    .limit(1);
  return existing !== undefined;
}

/**
 * Resolves proposals stranded at "approved" - the settlement that claimed
 * them died, or its outcome could not be observed at the time.
 *
 * - With a hash: only a definitive receipt moves it. Success executes it,
 *   a revert hands it back to the operator, anything else waits for the next
 *   pass. A transaction the node has never heard of is escalated rather than
 *   guessed at, because re-sending is not an option here.
 * - Without a hash: nothing was ever broadcast, so once it is provably stale
 *   the operator gets the proposal back.
 *
 * Returns how many proposals reached a terminal state.
 */
export async function reconcileApprovedProposals(
  treasuryId: string,
  signal?: AbortSignal,
): Promise<number> {
  const assertWorkerFence = () => signal?.throwIfAborted();
  const rows = await db
    .select()
    .from(treasuryProposalsTable)
    .where(
      and(
        eq(treasuryProposalsTable.treasuryId, treasuryId),
        eq(treasuryProposalsTable.status, "approved"),
      ),
    );

  let resolved = 0;
  for (const row of rows) {
    const ageMs = Date.now() - (row.decidedAt ?? row.createdAt).getTime();

    let resolution: "executed" | "pending";
    let reason: string;
    /** The fill this pass managed to recover, for the audit trail. */
    let realisedOutput: string | null = null;

    if (row.executionTxHash) {
      if (ageMs < SETTLEMENT_GRACE_MS) continue;
      assertWorkerFence();
      const outcome = await getTransferRecoveryStatus(row.executionTxHash as Hex);
      if (outcome === "success") {
        resolution = "executed";
        reason = `The rebalance swap confirmed on Arc (tx ${row.executionTxHash}). The proposal was settling when its request ended, so its outcome was read back from the chain.`;
      } else if (outcome === "reverted") {
        resolution = "pending";
        reason = `The rebalance swap reverted on Arc (tx ${row.executionTxHash}), so no holdings moved and the proposal is actionable again.`;
      } else {
        if (outcome === "missing" && ageMs >= MISSING_TX_REVIEW_MS) {
          assertWorkerFence();
          if (!(await alreadyFlaggedForReview(row.id))) {
            await raiseAlert({
              treasuryId,
              severity: "critical",
              kind: MANUAL_REVIEW_ALERT,
              title: "Rebalance requires manual review",
              detail:
                "A rebalance swap was broadcast but Arc has no record of the transaction. It is not re-sent and the proposal stays approved, so it cannot be traded twice. Operator review is required.",
              data: { proposalId: row.id, txHash: row.executionTxHash },
            });
          }
        }
        continue;
      }
    } else {
      // The hash is always written before broadcast, so a stale claim with no
      // hash was definitively never sent.
      if (ageMs < NO_BROADCAST_RECOVERY_MS) continue;
      resolution = "pending";
      reason =
        "The approval was recorded but its settlement never reached the point of broadcasting a swap, so no holdings moved and the proposal is actionable again.";
    }

    assertWorkerFence();
    const updated = await writeIfStillApproved(
      treasuryId,
      row.id,
      resolution === "executed"
        ? { status: "executed", decidedAt: new Date() }
        : { status: "pending", decidedAt: null },
    );
    // Another instance (or the original settlement) got there first: it owns
    // the operator-facing record of this resolution, so this pass stays quiet.
    if (!updated) continue;
    resolved += 1;

    if (resolution === "executed") {
      // The balance this swap was sized against is long gone, but the
      // transfer that paid it out is still in its receipt, so a recovered
      // rebalance can report what it returned and not only where the book
      // ended up. Both reads are reporting: neither can undo the resolution.
      assertWorkerFence();
      const fill = row.executionTxHash
        ? await readFillFromReceipt(treasuryId, row.executionTxHash as Hex)
        : null;
      assertWorkerFence();
      const outcome = await readSettledOutcome(
        treasuryId,
        await getMarketQuote(),
        fill ?? undefined,
      );
      realisedOutput = outcome.realisedOutput;
      if (fill && outcome.realisedOutput !== null) {
        // No quote survives here to measure it against, so the fill is
        // reported as the amount it is rather than as slippage.
        reason += ` The swap returned ${outcome.realisedOutput} ${fill.token.symbol}, read from its transfer logs.`;
      }
      if (outcome.holdingsAfter.length > 0) {
        reason += ` The treasury now holds ${describeHoldings(outcome.holdingsAfter)}.`;
      }
      if (outcome.realisedNote) reason += ` ${outcome.realisedNote}`;
    }

    assertWorkerFence();
    await logActivity(
      treasuryId,
      resolution === "executed" ? "Rebalance settled on Arc" : "Rebalance did not settle",
      reason,
      resolution === "executed" ? "executed" : "failed",
      row.executionTxHash ? "onchain" : "system",
      row.executionTxHash,
    );
    assertWorkerFence();
    await auditSafe({
      action: "proposal.reconcile",
      actorWallet: null,
      treasuryId,
      resourceId: row.id,
      result: resolution === "executed" ? "ok" : "failed",
      reason,
      detail: { status: resolution, txHash: row.executionTxHash, realisedOutput },
    });
  }

  return resolved;
}
