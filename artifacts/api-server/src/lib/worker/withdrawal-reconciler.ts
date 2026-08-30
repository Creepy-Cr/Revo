import { db, treasuriesTable } from "@workspace/db";
import { reconcilePendingWithdrawals } from "../../routes/treasury-wallet";
import { raiseAlert } from "../alerts";
import { assertWorkerLease, type WorkerJob } from "./index";

/**
 * Continuously resolves pending withdrawals for ALL wallets - not just the
 * one currently viewing the app. The same status-guarded, funds-safe
 * resolution logic the position read path uses: definitive receipts confirm
 * or refund; provably never-broadcast rows are refunded once stale.
 */
export const withdrawalReconcilerJob: WorkerJob = {
  name: "withdrawal-reconciler",
  intervalMs: 30_000,
  run: async (signal) => {
    const treasuries = await db.select({ id: treasuriesTable.id }).from(treasuriesTable);
    for (const treasury of treasuries) {
      try {
        assertWorkerLease(signal);
        await reconcilePendingWithdrawals(treasury.id, undefined, signal);
      } catch (error) {
        assertWorkerLease(signal);
        await raiseAlert({
          treasuryId: treasury.id,
          severity: "critical",
          kind: "worker.withdrawal-reconciler.failed",
          title: "Withdrawal reconciliation failed",
          detail: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
    }
  },
};
