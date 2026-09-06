/**
 * The drawdown monitor's outage gate.
 *
 * An incomplete valuation understates NAV, and understated NAV is exactly
 * what a drawdown looks like: an unreachable Arc RPC would otherwise page the
 * operators with a critical breach over a network blip. The monitor must stay
 * idle in that state.
 *
 * The two cases run the same fixture and the same understated NAV, differing
 * only in whether the valuation is trustworthy. The second one raises the
 * breach, which is what makes the first one's silence evidence of the gate
 * rather than an inert test.
 *
 * Both drive the per-treasury check rather than the job's loop: this database
 * is the shared development one, and the loop would process every treasury in
 * it.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentActivitiesTable,
  alertsTable,
  auditEventsTable,
  db,
  navSnapshotsTable,
  policiesTable,
  treasuriesTable,
  workerStateTable,
} from "@workspace/db";

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

const computeDashboard = vi.fn();

vi.mock("../state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state")>();
  return { ...actual, computeDashboard };
});

const { processTreasury } = await import("./drawdown-monitor");

const JOB_NAME = "drawdown-monitor";
/** Highest NAV recorded since the policy went active. */
const PEAK_NAV = 1000;
/** What the deposit-ledger fallback reports while Arc is unreachable. */
const OUTAGE_NAV = 120;
const DRAWDOWN_LIMIT_PCT = 10;

const treasuryIds: string[] = [];
let treasuryId: string;
let policyId: string;

async function seedTreasury(): Promise<void> {
  treasuryId = `test-drawdown-${randomUUID()}`;
  policyId = `pol-${randomUUID()}`;
  treasuryIds.push(treasuryId);
  await db.insert(treasuriesTable).values({
    id: treasuryId,
    name: "Drawdown monitor test",
    ownerWallet: `0x${randomUUID().replace(/-/g, "")}`,
  });
  await db.insert(policiesTable).values({
    id: policyId,
    treasuryId,
    name: "Conservative mandate",
    summary: `Hold the drawdown under ${DRAWDOWN_LIMIT_PCT}%.`,
    sourceCommand: "keep drawdown under 10%",
    rules: {
      maxAllocationPct: 35,
      stablecoinReserveMinPct: 25,
      drawdownLimitPct: DRAWDOWN_LIMIT_PCT,
      riskTolerance: "medium",
    },
    status: "active",
    decidedAt: new Date(Date.now() - 60 * 60_000),
  });
  await db.insert(navSnapshotsTable).values({
    id: `nav-${treasuryId}-peak`,
    treasuryId,
    time: new Date(Date.now() - 30 * 60_000),
    value: PEAK_NAV,
  });
}

function dashboardReturns(dashboard: Record<string, unknown>): void {
  computeDashboard.mockImplementation(async (id: string) => {
    if (id !== treasuryId) throw new Error("treasury not under test");
    return dashboard;
  });
}

/**
 * The per-treasury check, not the job's loop. These tests share the real
 * development database, and the loop would process every treasury in it.
 */
async function runMonitor(): Promise<string | void> {
  return processTreasury(treasuryId, new AbortController().signal);
}

async function alertsFor(id: string) {
  return db.select().from(alertsTable).where(eq(alertsTable.treasuryId, id));
}

async function activitiesFor(id: string) {
  return db.select().from(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, id));
}

async function checkpointFor(id: string): Promise<unknown> {
  const [row] = await db
    .select()
    .from(workerStateTable)
    .where(eq(workerStateTable.id, `${JOB_NAME}:${id}`));
  return row?.checkpoint ?? null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  await seedTreasury();
});

afterAll(async () => {
  for (const id of treasuryIds) {
    await db.delete(alertsTable).where(eq(alertsTable.treasuryId, id));
    await db.delete(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, id));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, id));
    await db.delete(navSnapshotsTable).where(eq(navSnapshotsTable.treasuryId, id));
    await db.delete(policiesTable).where(eq(policiesTable.treasuryId, id));
    await db.delete(workerStateTable).where(eq(workerStateTable.id, `${JOB_NAME}:${id}`));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, id));
  }
});

describe("drawdown monitor on an incomplete valuation", () => {
  it("takes no action and raises no alert while Arc cannot be read", async () => {
    dashboardReturns({
      totalValue: OUTAGE_NAV,
      valuation: {
        complete: false,
        note: "Arc could not be read (connect ETIMEDOUT), so the deposit ledger is shown instead of live balances.",
      },
    });

    const summary = await runMonitor();

    expect(await alertsFor(treasuryId)).toHaveLength(0);
    expect(await activitiesFor(treasuryId)).toHaveLength(0);
    // No episode was opened, so recovery cannot later be announced for a
    // breach that never happened.
    expect(await checkpointFor(treasuryId)).toBeNull();
    expect(String(summary)).toContain("Valuation incomplete");
  });

  it("does raise the breach once the same NAV comes from a trusted valuation", async () => {
    dashboardReturns({ totalValue: OUTAGE_NAV, valuation: { complete: true } });

    const summary = await runMonitor();

    expect(String(summary)).toContain("Breach recorded");
    const alerts = await alertsFor(treasuryId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ severity: "critical", kind: "drawdown.breach" });
    expect(await activitiesFor(treasuryId)).toHaveLength(1);
    expect(await checkpointFor(treasuryId)).toMatchObject({ breachedPolicyId: policyId });
  });
});
