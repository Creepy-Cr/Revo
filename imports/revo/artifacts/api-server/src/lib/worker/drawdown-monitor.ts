import {
  db,
  navSnapshotsTable,
  policiesTable,
  treasuriesTable,
  treasurySettingsTable,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { raiseAlert } from "../alerts";
import { auditSafe } from "../audit";
import { computeDashboard, logActivity } from "../state";
import { getCheckpoint, setCheckpoint, type WorkerJob } from "./index";

/**
 * Drawdown monitor: watches real NAV against the ACTIVE policy's drawdown
 * limit even when nobody has the console open.
 *
 * - Peak reference: highest NAV snapshot since the policy went active.
 * - Breach fires ONCE per episode (persisted checkpoint), recovery uses
 *   hysteresis (75% of the limit) so a NAV hovering at the threshold cannot
 *   spam alerts.
 * - Reaction: durable alert + activity + audit event. Automated de-risking
 *   is gated behind DRAWDOWN_AUTO_DERISK=true AND autonomous mode, and ships
 *   DISABLED - the operators' explicit decision stays in charge.
 */

const JOB_NAME = "drawdown-monitor";

interface DrawdownCheckpoint {
  /** Policy id currently in a breached episode, or null when healthy. */
  breachedPolicyId: string | null;
}

async function processTreasury(treasuryId: string): Promise<string | void> {
  const [policy] = await db
    .select()
    .from(policiesTable)
    .where(
      and(
        eq(policiesTable.treasuryId, treasuryId),
        eq(policiesTable.status, "active"),
      ),
    )
    .orderBy(desc(policiesTable.decidedAt))
    .limit(1);
  const checkpoint = (await getCheckpoint<DrawdownCheckpoint>(JOB_NAME, treasuryId)) ?? {
    breachedPolicyId: null,
  };

  if (!policy) {
    if (checkpoint.breachedPolicyId) {
      await setCheckpoint(JOB_NAME, treasuryId, { breachedPolicyId: null });
    }
    return;
  }

  let nav: number;
  try {
    nav = (await computeDashboard(treasuryId)).totalValue;
  } catch {
    return "Treasury state unavailable; monitor idle";
  }
  if (nav <= 0) {
    // Empty treasury has no drawdown; also close any open episode.
    if (checkpoint.breachedPolicyId) {
      await setCheckpoint(JOB_NAME, treasuryId, { breachedPolicyId: null });
    }
    return;
  }

  const since = policy.decidedAt ?? policy.createdAt;
  const [peakRow] = await db
    .select({ peak: sql<number | null>`max(${navSnapshotsTable.value})` })
    .from(navSnapshotsTable)
    .where(
      and(
        eq(navSnapshotsTable.treasuryId, treasuryId),
        gte(navSnapshotsTable.time, since),
      ),
    );
  const peak = Math.max(peakRow?.peak ?? 0, nav);
  if (peak <= 0) return;

  const drawdownPct = ((peak - nav) / peak) * 100;
  const limit = policy.rules.drawdownLimitPct;
  const breached = drawdownPct > limit;
  const recovered = drawdownPct < limit * 0.75;

  if (breached && checkpoint.breachedPolicyId !== policy.id) {
    await setCheckpoint(JOB_NAME, treasuryId, { breachedPolicyId: policy.id });

    const ddText = `${drawdownPct.toFixed(2)}%`;
    const detail =
      `Portfolio drawdown ${ddText} breached the ${limit}% limit set by policy "${policy.name}" ` +
      `(peak $${Math.round(peak).toLocaleString("en-US")} → now $${Math.round(nav).toLocaleString("en-US")}). ` +
      `Automated de-risking is disabled. Operator action required: review allocations or switch to Safe mode.`;

    await raiseAlert({
      treasuryId,
      severity: "critical",
      kind: "drawdown.breach",
      title: `Drawdown limit breached (${ddText} > ${limit}%)`,
      detail,
      data: { policyId: policy.id, drawdownPct, limit, peak, nav },
    });
    await logActivity(treasuryId, "Drawdown limit breached", detail, "observed");
    await auditSafe({
      treasuryId,
      action: "treasury.drawdown_breach",
      actorWallet: null,
      resourceId: policy.id,
      result: "ok",
      reason: `drawdown ${ddText} > limit ${limit}%`,
      detail: { drawdownPct, limit, peak, nav },
    });

    // Event autonomy (ships disabled): only ever acts in autonomous mode AND
    // with the explicit env opt-in. Even then, v1 limits itself to raising
    // the alarm - executing a de-risk trade without an approved proposal
    // would bypass the approval flow the operators chose.
    const autoDerisk = process.env.DRAWDOWN_AUTO_DERISK === "true";
    if (autoDerisk) {
      const [settings] = await db
        .select()
        .from(treasurySettingsTable)
        .where(eq(treasurySettingsTable.id, treasuryId));
      if (settings?.mode === "autonomous") {
        await logActivity(
          treasuryId,
          "Auto de-risk gate reached",
          "DRAWDOWN_AUTO_DERISK is enabled and the treasury is in auto-execute mode, but automated de-risk execution is not yet armed in the closed beta. No trade was made.",
          "observed",
        );
      }
    }
    return `Breach recorded: ${ddText} > ${limit}%`;
  }

  if (recovered && checkpoint.breachedPolicyId === policy.id) {
    await setCheckpoint(JOB_NAME, treasuryId, { breachedPolicyId: null });
    await raiseAlert({
      treasuryId,
      severity: "info",
      kind: "drawdown.recovered",
      title: "Drawdown recovered",
      detail: `Drawdown is back to ${drawdownPct.toFixed(2)}%, below the recovery threshold (${(limit * 0.75).toFixed(1)}%) for policy "${policy.name}".`,
      data: { policyId: policy.id, drawdownPct, limit },
    });
    return "Breach episode closed";
  }
}

async function runDrawdownMonitor(): Promise<string | void> {
  const treasuries = await db.select({ id: treasuriesTable.id }).from(treasuriesTable);
  const summaries: string[] = [];
  for (const treasury of treasuries) {
    try {
      const summary = await processTreasury(treasury.id);
      if (summary) summaries.push(`${treasury.id}: ${summary}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await raiseAlert({
        treasuryId: treasury.id,
        severity: "critical",
        kind: "worker.drawdown-monitor.failed",
        title: "Drawdown monitor failed",
        detail: message,
      }).catch(() => undefined);
    }
  }
  return summaries.length ? summaries.join("; ") : undefined;
}

export const drawdownMonitorJob: WorkerJob = {
  name: JOB_NAME,
  intervalMs: 60_000,
  run: runDrawdownMonitor,
};
