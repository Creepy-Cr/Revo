import { db, treasuriesTable } from "@workspace/db";
import { reconcileApprovedProposals } from "../rebalance-settlement";
import { raiseAlert } from "../alerts";
import { assertWorkerLease, type WorkerJob } from "./index";

/**
 * Resolves rebalances stranded at "approved" for EVERY treasury, whether or
 * not the request that approved them is still alive. Settlement outlives its
 * HTTP request now, so a redeploy, a crash, or an unreadable receipt would
 * otherwise leave a proposal parked forever beside holdings that may or may
 * not have moved.
 *
 * Reads receipts only - it never signs and never re-broadcasts - and every
 * write is guarded on the proposal still being unresolved, so running it on
 * several instances at once cannot duplicate a trade or a log line.
 */
export const rebalanceReconcilerJob: WorkerJob = {
  name: "rebalance-reconciler",
  intervalMs: 30_000,
  run: async (signal) => {
    const treasuries = await db.select({ id: treasuriesTable.id }).from(treasuriesTable);
    let resolved = 0;
    for (const treasury of treasuries) {
      try {
        assertWorkerLease(signal);
        resolved += await reconcileApprovedProposals(treasury.id, signal);
      } catch (error) {
        assertWorkerLease(signal);
        await raiseAlert({
          treasuryId: treasury.id,
          severity: "critical",
          kind: "worker.rebalance-reconciler.failed",
          title: "Rebalance reconciliation failed",
          detail: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    }
    return resolved > 0
      ? `Resolved ${resolved} stranded rebalance${resolved === 1 ? "" : "s"}`
      : undefined;
  },
};
