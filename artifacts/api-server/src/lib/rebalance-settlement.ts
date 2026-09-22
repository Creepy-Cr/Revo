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
 *
 * A confirmed swap is one leg of a target, not necessarily all of it. So the
 * hash write and "executed" are two different states with a re-plan between
 * them: "settled" is the leg confirmed, "executed" is the target either
 * reached or carried forward into a freshly drafted proposal. Both writes are
 * guarded, and the reconciler finishes any row left at "settled".
 */

import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Hex } from "viem";
import {
  alertsTable,
  db,
  policiesTable,
  treasuryProposalsTable,
  type AllocationTarget,
  type TreasuryProposal,
} from "@workspace/db";
import { getTransferRecoveryStatus, type CustodyTransaction } from "./arc-chain";
import { raiseAlert } from "./alerts";
import { auditSafe } from "./audit";
import { logger } from "./logger";
import { getMarketQuote, type MarketQuote } from "./market";
import { getMode } from "./operating-mode";
import {
  describeHoldings,
  planRebalanceLeg,
  readFillFromReceipt,
  readSettledOutcome,
  settleRebalance,
  type SwapLeg,
  type SwapSettlement,
} from "./rebalance-execution";
import { getSecurityControls, treasuryTransitionLock } from "./security-controls";
import { applyRebalance, logActivity } from "./state";

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

/**
 * Circuit breaker on unattended continuation. A target that needs several
 * legs is walked one approved swap at a time, and in Autonomous mode each
 * follow-up approves itself; this caps how many swaps one policy can chain
 * in an hour before the next one waits for an operator. A full rotation of
 * every tradable asset is well inside it, a planner and a market disagreeing
 * about where "on target" is would run past it.
 */
const MAX_AUTONOMOUS_LEGS_PER_HOUR = 12;

/** Proposal states that still lead to a swap, so a second draft would race them. */
const OPEN_PROPOSAL_STATUSES = ["pending", "simulation-ready", "approved"];

/** Where an approved target stands once a leg has confirmed. */
type Remainder =
  | { kind: "reached" }
  | { kind: "remaining"; leg: SwapLeg }
  | { kind: "unknown"; reason: string };

/**
 * Re-plans the approved target against live balances after a leg settled.
 * Planning only: nothing here quotes, signs or sends.
 */
async function remainderOfTarget(treasuryId: string, targets: AllocationTarget[]): Promise<Remainder> {
  try {
    const plan = await planRebalanceLeg(treasuryId, targets, await getMarketQuote());
    if (plan.kind === "swap") return { kind: "remaining", leg: plan.leg };
    if (plan.kind === "nothing-to-do") return { kind: "reached" };
    return { kind: "unknown", reason: plan.reason };
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : "The treasury could not be re-planned after the swap.",
    };
  }
}

function describeLeg(leg: SwapLeg): string {
  return `about $${leg.notionalUsd.toFixed(2)} of ${leg.input.symbol} still needs to move into ${leg.output.symbol}`;
}

/**
 * Carries an approved target forward once one of its legs has settled.
 *
 * Every pool Revo routes has USDC on one side, so a target that moves value
 * between two assets is reached over more than one swap, and each swap is
 * one proposal: one claim, one hash, one receipt, which is the invariant the
 * reconciler above rests on. So when a settled leg leaves the target short,
 * the next leg is drafted as a NEW proposal from live balances rather than
 * sent under the finished one, and the finished one's record says the target
 * is not yet reached. In Autonomous mode the follow-up approves itself under
 * exactly the gates a human approval passes (mode, pause, policy still
 * active, routable targets), and never when it would sell a holding the
 * targets leave nothing, or once the hourly circuit breaker trips.
 *
 * Returns the sentence the settled leg's activity entry ends with.
 */
async function continueTowardsTarget(
  treasuryId: string,
  settled: TreasuryProposal,
  targets: AllocationTarget[],
): Promise<string> {
  const remainder = await remainderOfTarget(treasuryId, targets);
  if (remainder.kind === "reached") {
    return "The approved target is now reached, so no further leg is needed.";
  }
  const standing =
    remainder.kind === "remaining"
      ? `This leg alone does not reach the approved target: ${describeLeg(remainder.leg)}.`
      : `Whether the approved target is now reached could not be confirmed: ${remainder.reason}`;

  try {
    const drafted = await draftFollowUp(treasuryId, settled, targets, remainder);
    return `${standing} ${drafted.note}`;
  } catch (error) {
    logger.error({ err: error, treasuryId, proposalId: settled.id }, "Follow-up rebalance leg could not be drafted");
    return `${standing} A follow-up proposal could not be drafted, so the remaining leg needs a fresh policy approval.`;
  }
}

async function draftFollowUp(
  treasuryId: string,
  settled: TreasuryProposal,
  targets: AllocationTarget[],
  remainder: Exclude<Remainder, { kind: "reached" }>,
): Promise<{ proposal: TreasuryProposal | null; note: string }> {
  const quote = await getMarketQuote();
  const now = new Date();
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(treasuryTransitionLock(treasuryId));

    // The follow-up enforces the same policy, and a policy that was
    // superseded meanwhile must not be enforced one more leg.
    let policyName: string | null = null;
    if (settled.policyId) {
      const [policy] = await tx
        .select({ name: policiesTable.name, status: policiesTable.status })
        .from(policiesTable)
        .where(and(eq(policiesTable.id, settled.policyId), eq(policiesTable.treasuryId, treasuryId)));
      if (!policy || policy.status !== "active") return { kind: "policy-inactive" as const };
      policyName = policy.name;
    }

    // A proposal without a policy is scoped to the whole treasury: any open
    // rebalance at all would race it.
    const policyScope = settled.policyId ? [eq(treasuryProposalsTable.policyId, settled.policyId)] : [];
    const [open] = await tx
      .select({ id: treasuryProposalsTable.id })
      .from(treasuryProposalsTable)
      .where(
        and(
          eq(treasuryProposalsTable.treasuryId, treasuryId),
          inArray(treasuryProposalsTable.status, OPEN_PROPOSAL_STATUSES),
          ...policyScope,
        ),
      )
      .limit(1);
    if (open) return { kind: "already-open" as const };

    // Why the follow-up waits for an operator, when it does.
    let holdReason: string | null = null;
    const mode = await getMode(treasuryId, tx);
    if (remainder.kind === "unknown") {
      holdReason = "the engine could not confirm what is left to do, so it does not approve this itself";
    } else if (mode !== "autonomous") {
      holdReason = null;
    } else if (
      remainder.leg.input.symbol !== "USDC" &&
      (targets.find((t) => t.symbol === remainder.leg.input.symbol)?.percentage ?? 0) <= 0
    ) {
      holdReason = `it sells ${remainder.leg.input.symbol} down to zero because the targets leave it nothing, and Autonomous mode does not auto-approve a sale the policy does not name`;
    } else if ((await getSecurityControls(treasuryId, tx)).pauseActive) {
      holdReason = "the emergency pause is active";
    } else {
      const [{ legs }] = await tx
        .select({ legs: sql<number>`count(*)::int` })
        .from(treasuryProposalsTable)
        .where(
          and(
            eq(treasuryProposalsTable.treasuryId, treasuryId),
            ...policyScope,
            eq(treasuryProposalsTable.status, "executed"),
            isNotNull(treasuryProposalsTable.executionTxHash),
            gt(treasuryProposalsTable.decidedAt, new Date(now.getTime() - 60 * 60_000)),
          ),
        );
      if (legs >= MAX_AUTONOMOUS_LEGS_PER_HOUR) {
        holdReason = `Autonomous mode has already settled ${legs} swaps for this policy in the last hour, which is its limit for unattended continuation`;
      }
    }
    const autonomous = mode === "autonomous" && holdReason === null;

    const baseTitle = settled.title.replace(/ \(next leg\)$/, "");
    const summary =
      remainder.kind === "remaining"
        ? `Continues the rebalance the previous leg started: ${describeLeg(remainder.leg)}. Sized again from live balances when it settles. ${
            autonomous
              ? "Auto-approved under Autonomous mode because it stays inside the active policy."
              : mode === "autonomous"
                ? `Waiting for operator approval because ${holdReason}.`
                : "Waiting for operator approval."
          }`
        : `Drafted because the previous leg could not confirm whether the target is reached: ${remainder.reason} If the target is already met, approving this settles without a swap. Waiting for operator approval.`;

    const [proposal] = await tx
      .insert(treasuryProposalsTable)
      .values({
        id: `revo-${randomUUID()}`,
        treasuryId,
        title: `${policyName ? `Rebalance to "${policyName}" targets` : baseTitle} (next leg)`,
        summary,
        status: autonomous ? "approved" : "pending",
        createdAt: now,
        action: settled.action,
        safetyChecks: [
          ...settled.safetyChecks,
          "Continuation leg: one swap per approval, re-planned from live balances at settlement under the same guards.",
        ],
        command: settled.command,
        policyId: settled.policyId,
        targetAllocations: targets,
        decidedAt: autonomous ? now : null,
      })
      .returning();
    if (!proposal) throw new Error("Follow-up proposal insert returned no row");
    if (autonomous) {
      // Same validation a human approval gets, inside the same transaction:
      // unroutable targets roll the auto-approval back.
      await applyRebalance(tx, treasuryId, targets, quote);
    }
    return { kind: "drafted" as const, proposal, autonomous, holdReason, mode };
  });

  if (outcome.kind === "policy-inactive") {
    return { proposal: null, note: "The policy this rebalance enforced is no longer active, so no follow-up was drafted." };
  }
  if (outcome.kind === "already-open") {
    return { proposal: null, note: "A rebalance for this policy is already waiting or settling, so no second one was drafted." };
  }
  if (outcome.autonomous) {
    startProposalSettlement(treasuryId, outcome.proposal, quote);
    return {
      proposal: outcome.proposal,
      note: "A follow-up proposal has been drafted from live balances and auto-approved under Autonomous mode; it is settling now.",
    };
  }
  return {
    proposal: outcome.proposal,
    note:
      outcome.mode === "autonomous" && outcome.holdReason
        ? `A follow-up proposal has been drafted from live balances and waits for operator approval, because ${outcome.holdReason}.`
        : "A follow-up proposal has been drafted from live balances and waits for operator approval.",
  };
}

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
 * Status of a proposal whose one swap has confirmed but whose target has not
 * yet been re-planned. It is written in the same guarded update as the hash
 * that proves the swap, so a crash between the swap confirming and the next
 * leg being drafted leaves a row the reconciler can find and finish: nothing
 * reads "executed" until the continuation is on record.
 */
const LEG_SETTLED_STATUS = "settled";

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
 * Finishes a proposal whose swap has confirmed: re-plans the target, drafts
 * the next leg if one is owed, and only then moves the row from "settled" to
 * "executed", appending where the target stands to the card's own summary so
 * the console never shows a green "executed" beside a target that still has
 * a leg to go. The executed write is the claim on the activity entry, so a
 * live settlement and a reconciler finishing the same row log it once.
 *
 * Idempotent by construction: a rerun after a crash re-plans from live
 * balances, and the open-proposal check inside the draft means a child that
 * already exists is found, not duplicated.
 */
async function completeSettledLeg(
  treasuryId: string,
  row: TreasuryProposal,
  describe: (standing: string) => string,
): Promise<TreasuryProposal | undefined> {
  const targets = row.targetAllocations ?? [];
  const standing = targets.length > 0 ? await continueTowardsTarget(treasuryId, row, targets) : "";
  const [executed] = await db
    .update(treasuryProposalsTable)
    .set({ status: "executed", summary: standing ? `${row.summary} ${standing}` : row.summary })
    .where(
      and(
        eq(treasuryProposalsTable.id, row.id),
        eq(treasuryProposalsTable.treasuryId, treasuryId),
        eq(treasuryProposalsTable.status, LEG_SETTLED_STATUS),
      ),
    )
    .returning();
  if (executed) {
    await logActivity(
      treasuryId,
      "Rebalance settled on Arc",
      describe(standing),
      "executed",
      "onchain",
      row.executionTxHash,
    );
  }
  return executed;
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
      `Swapped ${settlement.amountIn} ${settlement.inputSymbol} on Uniswap v4 (${tier}) against a quote of ${settlement.expectedOutput} ${settlement.outputSymbol}, with a floor of ${settlement.minOutput} ${settlement.outputSymbol}.`,
    );
  } else {
    parts.push(
      `Swapped ${settlement.amountIn} ${settlement.inputSymbol} and received ${settlement.realisedOutput} ${settlement.outputSymbol} on Uniswap v4 (${tier}), against a quote of ${settlement.expectedOutput} and a floor of ${settlement.minOutput} ${settlement.outputSymbol}.`,
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
 *   - nothing-to-do: the target is genuinely reached, so "executed".
 *   - settled: this proposal's one swap confirmed. The row goes to "settled",
 *     the target is re-planned from live balances and the next leg drafted as
 *     a fresh proposal when one is owed, and only then does it read
 *     "executed" (completeSettledLeg). A crash in between leaves a "settled"
 *     row the reconciler finishes.
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
    // The swap confirming makes the row "settled", never "executed" yet:
    // whether the target itself is reached is checked against live balances
    // next, the next leg drafted when one is owed, and only that completion
    // writes "executed". Anything that dies in between leaves a "settled"
    // row for the reconciler to finish.
    const settledRow = await writeIfStillApproved(treasuryId, proposal.id, {
      status: LEG_SETTLED_STATUS,
      decidedAt: new Date(),
      executionTxHash: settlement.txHash,
    });
    if (!settledRow) return { kind: "executed", proposal, settlement };
    const executed = await completeSettledLeg(treasuryId, settledRow, (standing) =>
      `${describeSettlement(settlement, proposal.action)} ${standing}`.trimEnd(),
    );
    return { kind: "executed", proposal: executed ?? settledRow, settlement };
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
        ? { status: LEG_SETTLED_STATUS, decidedAt: new Date() }
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
      // A recovered leg is still only one leg: the target it served may need
      // another, and losing the process must not lose the rest of it. The
      // row sits at "settled" until this has run, so an abort here is picked
      // up by the sweep below rather than lost.
      assertWorkerFence();
      const recovered = reason;
      await completeSettledLeg(treasuryId, updated, (standing) => `${recovered} ${standing}`.trimEnd());
    } else {
      assertWorkerFence();
      await logActivity(treasuryId, "Rebalance did not settle", reason, "failed", row.executionTxHash ? "onchain" : "system", row.executionTxHash);
    }
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

  // Rows whose swap confirmed but whose continuation never finished: the
  // process ended, or the worker's lease did, between the settled write and
  // the executed one. Finishing them is idempotent (see completeSettledLeg).
  const stranded = await db
    .select()
    .from(treasuryProposalsTable)
    .where(
      and(
        eq(treasuryProposalsTable.treasuryId, treasuryId),
        eq(treasuryProposalsTable.status, LEG_SETTLED_STATUS),
      ),
    );
  for (const row of stranded) {
    const ageMs = Date.now() - (row.decidedAt ?? row.createdAt).getTime();
    if (ageMs < SETTLEMENT_GRACE_MS) continue;
    assertWorkerFence();
    const executed = await completeSettledLeg(
      treasuryId,
      row,
      (standing) =>
        `The rebalance swap confirmed on Arc (tx ${row.executionTxHash}), but the process ended before the approved target was re-planned, so reconciliation finished it. ${standing}`.trimEnd(),
    );
    if (!executed) continue;
    resolved += 1;
    assertWorkerFence();
    await auditSafe({
      action: "proposal.reconcile",
      actorWallet: null,
      treasuryId,
      resourceId: row.id,
      result: "ok",
      reason: "Finished the continuation of a settled rebalance leg whose process ended early.",
      detail: { status: "executed", txHash: row.executionTxHash },
    });
  }

  return resolved;
}
