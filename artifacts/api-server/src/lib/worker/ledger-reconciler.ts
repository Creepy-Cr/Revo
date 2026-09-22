import { db, treasuriesTable } from "@workspace/db";
import { raiseAlert } from "../alerts";
import { readCustodyHoldings } from "../holdings";
import { logger } from "../logger";
import { getMarketQuote, referencePriceFor } from "../market";
import { setEmergencyPause } from "../security-controls";
import { loadState } from "../state";
import { assertWorkerLease, getCheckpoint, setCheckpoint, type WorkerJob } from "./index";

const JOB_NAME = "ledger-reconciler";
const SYSTEM_ACTOR = "system";

interface LedgerCheckpoint {
  discrepancy: string | null;
  checkedAt: string;
}

function discrepancyKey(kind: "shortfall" | "surplus", difference: number): string {
  return `${kind}:${difference.toFixed(2)}`;
}

export async function processTreasury(
  treasuryId: string,
  signal: AbortSignal,
): Promise<string | void> {
  const custody = await readCustodyHoldings(treasuryId, signal);
  if (!custody.ok) {
    logger.warn({ treasuryId, error: custody.error }, "Ledger reconciliation skipped because Arc could not be read");
    return "Arc read failed; reconciliation idle";
  }

  const [state, quote] = await Promise.all([loadState(treasuryId, signal), getMarketQuote()]);
  if (!quote) {
    logger.warn({ treasuryId }, "Ledger reconciliation skipped because market prices are unavailable");
    return "Market price unavailable; reconciliation idle";
  }
  let chainValue = 0;
  for (const holding of custody.holdings) {
    const price = referencePriceFor(holding.priceId, quote);
    if (holding.units > 0 && price === undefined) {
      logger.warn({ treasuryId, symbol: holding.symbol }, "Ledger reconciliation skipped because a holding cannot be valued");
      return "Holding price unavailable; reconciliation idle";
    }
    chainValue += holding.units * (price ?? 0);
  }
  const ledgerValue = state.usdcUnits * quote.usdcUsd;
  const difference = chainValue - ledgerValue;
  // Arc gas is paid by the custody wallet in USDC. This tolerance absorbs normal gas spend.
  const tolerance = Math.max(1, ledgerValue * 0.005);
  const checkpoint = await getCheckpoint<LedgerCheckpoint>(JOB_NAME, treasuryId);
  const checkedAt = new Date().toISOString();

  if (difference < -tolerance) {
    const shortfall = Math.abs(difference);
    const key = discrepancyKey("shortfall", shortfall);
    const reason = `Ledger reconciliation detected a ${shortfall.toFixed(2)} USDC shortfall (ledger ${ledgerValue.toFixed(2)} USDC, on-chain ${chainValue.toFixed(2)} USDC).`;
    if (checkpoint?.discrepancy !== key) {
      assertWorkerLease(signal);
      await setEmergencyPause({
        treasuryId,
        active: true,
        reason,
        actorWallet: SYSTEM_ACTOR,
        actorRole: SYSTEM_ACTOR,
      });
      assertWorkerLease(signal);
      await raiseAlert({
        treasuryId,
        severity: "critical",
        kind: "ledger.chain-mismatch",
        title: "Custody balance is below the ledger",
        detail: reason,
        data: { ledgerValue, chainValue, discrepancy: shortfall, tolerance },
      });
    }
    await setCheckpoint(JOB_NAME, treasuryId, { discrepancy: key, checkedAt }, signal);
    return reason;
  }

  if (difference > tolerance) {
    const key = discrepancyKey("surplus", difference);
    if (checkpoint?.discrepancy !== key) {
      assertWorkerLease(signal);
      await raiseAlert({
        treasuryId,
        severity: "warning",
        kind: "ledger.chain-mismatch",
        title: "Custody balance is above the ledger",
        detail: `On-chain custody exceeds the ledger by ${difference.toFixed(2)} USDC. This may be an untracked deposit.`,
        data: { ledgerValue, chainValue, discrepancy: difference, tolerance },
      });
    }
    await setCheckpoint(JOB_NAME, treasuryId, { discrepancy: key, checkedAt }, signal);
    return `Surplus detected: ${difference.toFixed(2)} USDC`;
  }

  await setCheckpoint(JOB_NAME, treasuryId, { discrepancy: null, checkedAt }, signal);
  return "Ledger and custody balances reconcile";
}

async function runLedgerReconciler(signal: AbortSignal): Promise<string | void> {
  const treasuries = await db.select({ id: treasuriesTable.id }).from(treasuriesTable);
  const summaries: string[] = [];
  for (const treasury of treasuries) {
    assertWorkerLease(signal);
    try {
      const summary = await processTreasury(treasury.id, signal);
      if (summary) summaries.push(`${treasury.id}: ${summary}`);
    } catch (error) {
      logger.warn({ treasuryId: treasury.id, err: error }, "Ledger reconciliation failed");
    }
  }
  return summaries.length ? summaries.join("; ") : undefined;
}

export const ledgerReconcilerJob: WorkerJob = {
  name: JOB_NAME,
  intervalMs: 5 * 60_000,
  run: runLedgerReconciler,
};