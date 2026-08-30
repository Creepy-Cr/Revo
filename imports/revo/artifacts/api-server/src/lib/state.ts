import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  agentActivitiesTable,
  db,
  navSnapshotsTable,
  onchainTransfersTable,
  treasuryStateTable,
  type TreasuryState,
} from "@workspace/db";
import { getMarketQuote, type MarketQuote } from "./market";

/**
 * DB-backed treasury simulation state.
 *
 * The treasury holds units (USDC, aUSDC, sUSDC, ETH). Dollar values are
 * computed at read time from live market quotes, NAV snapshots accumulate in
 * the database, and the activity log records real events (initialization,
 * proposals, drills). Nothing served from the dashboard is hardcoded.
 */

const SNAPSHOT_THROTTLE_MS = 5 * 60_000;
const HISTORY_LIMIT = 96;
const ACTIVITY_LIMIT = 12;

/** The DAO mandate - these are the actual rules enforced by the compiler prompt and drill. */
export const GUARDRAILS = [
  { id: "g-1", label: "Max protocol exposure", value: "35%", state: "active" },
  { id: "g-2", label: "Minimum liquid reserve", value: "25%", state: "active" },
  { id: "g-3", label: "Emergency exit threshold", value: "Risk 80+", state: "armed" },
  { id: "g-4", label: "Execution environment", value: "Testnet only", state: "locked" },
];

export async function logActivity(
  treasuryId: string,
  title: string,
  detail: string,
  status: string,
): Promise<void> {
  await db.insert(agentActivitiesTable).values({
    id: `act-${randomUUID()}`,
    treasuryId,
    time: new Date(),
    title,
    detail,
    status,
  });
}

async function initializeState(treasuryId: string, quote: MarketQuote): Promise<TreasuryState> {
  // Real mode: the treasury opens EMPTY. Holdings only ever change through
  // real on-chain testnet USDC deposits/withdrawals (wallet routes) and
  // approved rebalances of those funds. The live quote is still required so
  // the stored last-known prices are real from the very first row.
  const [state] = await db
    .insert(treasuryStateTable)
    .values({
      id: treasuryId,
      usdcUnits: 0,
      aUsdcUnits: 0,
      sUsdcUnits: 0,
      ethUnits: 0,
      lastEthPrice: quote.ethUsd,
      lastUsdcPrice: quote.usdcUsd,
      status: "AUTONOMOUS",
      network: "Arc Testnet",
    })
    .onConflictDoNothing()
    .returning();

  if (state) {
    await logActivity(
      treasuryId,
      "Treasury initialized",
      "Treasury opened empty on Arc Testnet. Every balance shown from here on comes from real on-chain testnet USDC deposits.",
      "executed",
    );
    return state;
  }

  // Another request initialized concurrently - load the winner.
  const [existing] = await db
    .select()
    .from(treasuryStateTable)
    .where(eq(treasuryStateTable.id, treasuryId));
  return existing;
}

/** Loads (or lazily initializes) the state row for ONE treasury. The row id IS the treasury id. */
export async function loadState(treasuryId: string): Promise<TreasuryState> {
  const [state] = await db
    .select()
    .from(treasuryStateTable)
    .where(eq(treasuryStateTable.id, treasuryId));
  if (state) return state;

  const quote = await getMarketQuote();
  if (!quote) {
    throw new Error(
      "Cannot initialize the treasury: live market data is unavailable. No synthetic prices will be used.",
    );
  }
  return initializeState(treasuryId, quote);
}

export interface ComputedDashboard {
  totalValue: number;
  /**
   * True once any confirmed deposit has ever landed. The console's first-run
   * activation gate keys off this, NOT totalValue - totalValue is rounded, so
   * a small funded balance (< $0.50) would otherwise read 0 and hide the real
   * dashboard (including an active drill's reset control).
   */
  funded: boolean;
  dayChange: number;
  deployed: number;
  riskScore: number;
  status: string;
  network: string;
  allocations: { symbol: string; name: string; percentage: number; value: number; tone: string }[];
  portfolioHistory: { label: string; value: number }[];
  activities: { id: string; time: string; title: string; detail: string; status: string }[];
  guardrails: { id: string; label: string; value: string; state: string }[];
}

export async function computeDashboard(treasuryId: string): Promise<ComputedDashboard> {
  const state = await loadState(treasuryId);
  const quote = await getMarketQuote();

  const ethPrice = quote?.ethUsd ?? state.lastEthPrice;
  const usdcPrice = quote?.usdcUsd ?? state.lastUsdcPrice;

  if (quote && !quote.stale) {
    await db
      .update(treasuryStateTable)
      .set({ lastEthPrice: quote.ethUsd, lastUsdcPrice: quote.usdcUsd, updatedAt: new Date() })
      .where(eq(treasuryStateTable.id, treasuryId));
  }

  const usdcValue = state.usdcUnits * usdcPrice;
  const aUsdcValue = state.aUsdcUnits * usdcPrice;
  const sUsdcValue = state.sUsdcUnits * usdcPrice;
  const ethValue = state.ethUnits * ethPrice;
  const totalValue = usdcValue + aUsdcValue + sUsdcValue + ethValue;

  // An empty treasury has no composition: all percentages are 0, not NaN.
  const pct = (v: number) => (totalValue > 0 ? Math.round((v / totalValue) * 1000) / 10 : 0);

  const allocations = [
    { symbol: "USDC", name: "Liquid reserve", percentage: pct(usdcValue), value: Math.round(usdcValue), tone: "cyan" },
    { symbol: "aUSDC", name: "Arc lending vault", percentage: pct(aUsdcValue), value: Math.round(aUsdcValue), tone: "violet" },
    { symbol: "sUSDC", name: "USDC safe reserve", percentage: pct(sUsdcValue), value: Math.round(sUsdcValue), tone: "amber" },
    { symbol: "ETH", name: "Directional sleeve", percentage: pct(ethValue), value: Math.round(ethValue), tone: "blue" },
  ];

  // Risk score derived from the actual composition: volatile exposure and
  // protocol concentration raise it; a thin liquid reserve raises it further.
  const liquidPct = pct(usdcValue);
  // An empty treasury carries no risk and has nothing deployed.
  const riskScore =
    totalValue > 0
      ? Math.round(
          Math.min(
            100,
            pct(ethValue) * 1.2 + pct(aUsdcValue) * 0.45 + Math.max(0, 25 - liquidPct) * 3,
          ),
        )
      : 0;

  await maybeSnapshot(treasuryId, totalValue);

  const history = await db
    .select()
    .from(navSnapshotsTable)
    .where(eq(navSnapshotsTable.treasuryId, treasuryId))
    .orderBy(desc(navSnapshotsTable.time))
    .limit(HISTORY_LIMIT);
  history.reverse();

  const dayAgo = Date.now() - 24 * 60 * 60_000;
  const reference =
    history.find((snap) => snap.time.getTime() >= dayAgo) ?? history[0];
  const dayChange =
    reference && reference.value > 0
      ? Math.round(((totalValue - reference.value) / reference.value) * 10000) / 100
      : 0;

  const activityRows = await db
    .select()
    .from(agentActivitiesTable)
    .where(eq(agentActivitiesTable.treasuryId, treasuryId))
    .orderBy(desc(agentActivitiesTable.time))
    .limit(ACTIVITY_LIMIT);

  const [firstDeposit] = await db
    .select({ id: onchainTransfersTable.id })
    .from(onchainTransfersTable)
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, treasuryId),
        eq(onchainTransfersTable.direction, "deposit"),
        eq(onchainTransfersTable.status, "confirmed"),
      ),
    )
    .limit(1);

  return {
    totalValue: Math.round(totalValue),
    funded: firstDeposit !== undefined,
    dayChange,
    deployed: totalValue > 0 ? Math.round((100 - liquidPct) * 10) / 10 : 0,
    riskScore,
    status: state.status,
    network: state.network,
    allocations,
    portfolioHistory: history.map((snap) => ({
      label: snap.time.toISOString(),
      value: Math.round(snap.value),
    })),
    activities: activityRows.map((row) => ({
      id: row.id,
      time: row.time.toISOString(),
      title: row.title,
      detail: row.detail,
      status: row.status,
    })),
    guardrails: GUARDRAILS,
  };
}

async function maybeSnapshot(treasuryId: string, totalValue: number): Promise<void> {
  // Deterministic time-bucket id makes the throttle concurrency-safe:
  // parallel dashboard polls in the same window collide on the primary key
  // and only one snapshot lands per window (per treasury).
  const bucket = Math.floor(Date.now() / SNAPSHOT_THROTTLE_MS);
  await db
    .insert(navSnapshotsTable)
    .values({
      id: `nav-${treasuryId}-${bucket}`,
      treasuryId,
      time: new Date(),
      value: totalValue,
    })
    .onConflictDoNothing();
}

/** Executor type so state mutations can run inside a caller's transaction. */
export type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const REBALANCE_SYMBOLS = ["USDC", "aUSDC", "sUSDC", "ETH"];

/**
 * Applies an approved rebalance: converts the treasury's unit holdings so the
 * portfolio matches the target percentage allocation at current prices. Total
 * value is conserved (simulated execution, no slippage) - only the split
 * between holdings changes.
 *
 * Runs on the caller's executor so the holdings write commits (or rolls back)
 * atomically with the proposal's status transition. Throws on malformed
 * targets instead of writing a partial or nonsensical allocation.
 */
export async function applyRebalance(
  executor: DbExecutor,
  treasuryId: string,
  targets: { symbol: string; percentage: number }[],
  quote: MarketQuote | null,
): Promise<void> {
  if (targets.length === 0) {
    throw new Error("Rebalance targets are empty");
  }
  let totalPct = 0;
  for (const target of targets) {
    if (!REBALANCE_SYMBOLS.includes(target.symbol)) {
      throw new Error(`Unknown rebalance symbol: ${target.symbol}`);
    }
    if (!Number.isFinite(target.percentage) || target.percentage < 0 || target.percentage > 100) {
      throw new Error(`Invalid rebalance percentage for ${target.symbol}: ${target.percentage}`);
    }
    totalPct += target.percentage;
  }
  if (totalPct > 100.5) {
    throw new Error(`Rebalance targets exceed 100% (${totalPct}%)`);
  }

  const [state] = await executor
    .select()
    .from(treasuryStateTable)
    .where(eq(treasuryStateTable.id, treasuryId));
  if (!state) {
    throw new Error("Treasury state is not initialized; cannot rebalance");
  }
  const ethPrice = quote?.ethUsd ?? state.lastEthPrice;
  const usdcPrice = quote?.usdcUsd ?? state.lastUsdcPrice;

  const totalValue =
    state.usdcUnits * usdcPrice +
    state.aUsdcUnits * usdcPrice +
    state.sUsdcUnits * usdcPrice +
    state.ethUnits * ethPrice;

  const pctFor = (symbol: string): number | null => {
    const target = targets.find((t) => t.symbol === symbol);
    return target ? target.percentage : null;
  };

  const usdcPct = pctFor("USDC");
  const aUsdcPct = pctFor("aUSDC");
  const sUsdcPct = pctFor("sUSDC");
  const ethPct = pctFor("ETH");

  await executor
    .update(treasuryStateTable)
    .set({
      usdcUnits: usdcPct !== null ? (totalValue * usdcPct) / 100 / usdcPrice : state.usdcUnits,
      aUsdcUnits: aUsdcPct !== null ? (totalValue * aUsdcPct) / 100 / usdcPrice : state.aUsdcUnits,
      sUsdcUnits: sUsdcPct !== null ? (totalValue * sUsdcPct) / 100 / usdcPrice : state.sUsdcUnits,
      ethUnits: ethPct !== null ? (totalValue * ethPct) / 100 / ethPrice : state.ethUnits,
      lastEthPrice: ethPrice,
      lastUsdcPrice: usdcPrice,
      updatedAt: new Date(),
    })
    .where(eq(treasuryStateTable.id, treasuryId));
}
