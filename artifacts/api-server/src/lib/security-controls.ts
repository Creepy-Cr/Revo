import { and, eq, gt, ne, sql } from "drizzle-orm";
import {
  db,
  onchainTransfersTable,
  securityControlsTable,
  type SecurityControls,
} from "@workspace/db";
import { auditSafe } from "./audit";
import { custodySendLock, type CustodyTransaction } from "./arc-chain";

/**
 * Persisted security controls: the emergency kill switch and withdrawal /
 * outflow caps. Caps are enforced transactionally inside the withdrawal
 * reservation, so concurrent requests cannot jointly exceed a limit.
 */

/** Testnet defaults - admin-configurable via the security endpoints. */
const DEFAULT_LIMITS = {
  maxPerWithdrawalUsdc: 25_000,
  maxWallet24hUsdc: 50_000,
  maxGlobal24hUsdc: 100_000,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Includes the custody lock's own client, which sends money outside any transaction. */
type DbOrTx = typeof db | Tx | CustodyTransaction;

/**
 * Per-treasury advisory lock key for approval/withdrawal/pause ordering.
 * Every transition for ONE treasury serializes; tenants never block each other.
 */
export function treasuryTransitionLock(treasuryId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${`treasury-transition:${treasuryId}`}))`;
}

/** Controls are one row per treasury - the row id IS the treasury id. */
export async function getSecurityControls(
  treasuryId: string,
  executor: DbOrTx = db,
): Promise<SecurityControls> {
  const [existing] = await executor
    .select()
    .from(securityControlsTable)
    .where(eq(securityControlsTable.id, treasuryId));
  if (existing) return existing;
  await executor
    .insert(securityControlsTable)
    .values({ id: treasuryId, ...DEFAULT_LIMITS })
    .onConflictDoNothing({ target: securityControlsTable.id });
  const [created] = await executor
    .select()
    .from(securityControlsTable)
    .where(eq(securityControlsTable.id, treasuryId));
  return created;
}

export interface PauseChange {
  treasuryId: string;
  active: boolean;
  reason: string;
  actorWallet: string;
  actorRole: string;
}

/**
 * Flips the emergency pause under BOTH per-treasury locks, so a pause is
 * strictly ordered against every way value can leave:
 *   - the custody send lock covers a withdrawal that is already reserved and
 *     is being signed or broadcast. Activation waits for that transfer to be
 *     out of the door, and any send that starts afterwards reads the pause
 *     under the same lock and refuses. Without this the pause would only bind
 *     withdrawals that had not reserved yet.
 *   - the transition lock covers approvals, reservations and policy changes.
 * Taken in that order everywhere - a custody send never waits on a transition
 * lock, so the two can never deadlock.
 * Returns null when the pause is already in the requested state.
 */
export async function setEmergencyPause(change: PauseChange): Promise<SecurityControls | null> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(custodySendLock(change.treasuryId));
    await tx.execute(treasuryTransitionLock(change.treasuryId));
    const controls = await getSecurityControls(change.treasuryId, tx);
    if (controls.pauseActive === change.active) return null;
    const now = new Date();
    const [updated] = await tx
      .update(securityControlsTable)
      .set(
        change.active
          ? {
              pauseActive: true,
              pauseReason: change.reason,
              pauseActivatedBy: change.actorWallet,
              pauseActivatedAt: now,
              pauseRevision: controls.pauseRevision + 1,
              updatedBy: change.actorWallet,
            }
          : {
              pauseActive: false,
              pauseReason: change.reason,
              pauseDeactivatedBy: change.actorWallet,
              pauseDeactivatedAt: now,
              pauseRevision: controls.pauseRevision + 1,
              updatedBy: change.actorWallet,
            },
      )
      .where(eq(securityControlsTable.id, change.treasuryId))
      .returning();
    return updated;
  });
  if (result) {
    await auditSafe({
      action: change.active ? "security.pause.activate" : "security.pause.deactivate",
      treasuryId: change.treasuryId,
      actorWallet: change.actorWallet,
      actorRole: change.actorRole,
      result: "ok",
      reason: change.reason,
      detail: { revision: result.pauseRevision },
    });
  }
  return result;
}

export interface LimitsChange {
  treasuryId: string;
  maxPerWithdrawalUsdc: number;
  maxWallet24hUsdc: number;
  maxGlobal24hUsdc: number;
  actorWallet: string;
  actorRole: string;
}

export async function setSecurityLimits(change: LimitsChange): Promise<SecurityControls> {
  const updated = await db.transaction(async (tx) => {
    await tx.execute(treasuryTransitionLock(change.treasuryId));
    await getSecurityControls(change.treasuryId, tx);
    const [row] = await tx
      .update(securityControlsTable)
      .set({
        maxPerWithdrawalUsdc: change.maxPerWithdrawalUsdc,
        maxWallet24hUsdc: change.maxWallet24hUsdc,
        maxGlobal24hUsdc: change.maxGlobal24hUsdc,
        updatedBy: change.actorWallet,
      })
      .where(eq(securityControlsTable.id, change.treasuryId))
      .returning();
    return row;
  });
  await auditSafe({
    action: "security.limits.update",
    treasuryId: change.treasuryId,
    actorWallet: change.actorWallet,
    actorRole: change.actorRole,
    result: "ok",
    detail: {
      maxPerWithdrawalUsdc: change.maxPerWithdrawalUsdc,
      maxWallet24hUsdc: change.maxWallet24hUsdc,
      maxGlobal24hUsdc: change.maxGlobal24hUsdc,
    },
  });
  return updated;
}

/**
 * Why withdrawals are halted for this treasury right now, or null.
 *
 * One wording, read at both points a withdrawal can still be stopped: when it
 * reserves, and again before it is signed. Two copies of this could disagree
 * about what the pause covers, and the direction that fails open sends money.
 */
export function withdrawalHaltReason(controls: SecurityControls): string | null {
  if (controls.pauseActive) {
    return `Withdrawals are blocked: emergency pause is active${controls.pauseReason ? ` (${controls.pauseReason})` : ""}.`;
  }
  return null;
}

/**
 * Re-reads the halt for a withdrawal that has already reserved, on the custody
 * lock's client. The caller must hold the custody lock, which is what makes
 * the answer stable until the transfer is broadcast.
 */
export async function checkWithdrawalHalt(
  executor: DbOrTx,
  treasuryId: string,
): Promise<string | null> {
  return withdrawalHaltReason(await getSecurityControls(treasuryId, executor));
}

/**
 * Enforces withdrawal caps INSIDE the reservation transaction (which already
 * holds the transition lock). Rolling 24h sums count confirmed AND pending
 * withdrawals - pending rows have reserved units and must occupy the cap.
 * Returns an error message, or null when the withdrawal is within limits.
 */
export async function checkWithdrawalCaps(
  tx: Tx,
  treasuryId: string,
  wallet: string,
  amountUsdc: number,
): Promise<string | null> {
  const controls = await getSecurityControls(treasuryId, tx);
  const halted = withdrawalHaltReason(controls);
  if (halted) return halted;
  if (amountUsdc > controls.maxPerWithdrawalUsdc) {
    return `This withdrawal exceeds the per-transaction limit of ${controls.maxPerWithdrawalUsdc.toLocaleString("en-US")} USDC.`;
  }
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [sums] = await tx
    .select({
      walletSum: sql<number>`coalesce(sum(${onchainTransfersTable.amountUsdc}) FILTER (WHERE ${onchainTransfersTable.wallet} = ${wallet}), 0)::double precision`,
      globalSum: sql<number>`coalesce(sum(${onchainTransfersTable.amountUsdc}), 0)::double precision`,
    })
    .from(onchainTransfersTable)
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, treasuryId),
        eq(onchainTransfersTable.direction, "withdrawal"),
        ne(onchainTransfersTable.status, "failed"),
        gt(onchainTransfersTable.createdAt, since),
      ),
    );
  if (sums.walletSum + amountUsdc > controls.maxWallet24hUsdc) {
    return `This wallet has withdrawn ${sums.walletSum.toLocaleString("en-US")} USDC in the last 24h; the rolling limit is ${controls.maxWallet24hUsdc.toLocaleString("en-US")} USDC.`;
  }
  if (sums.globalSum + amountUsdc > controls.maxGlobal24hUsdc) {
    return `The treasury's global 24h outflow limit of ${controls.maxGlobal24hUsdc.toLocaleString("en-US")} USDC would be exceeded.`;
  }
  return null;
}
