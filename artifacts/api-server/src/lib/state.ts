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
import { getMarketQuote, referencePriceFor, type MarketQuote } from "./market";
import { readCustodyHoldings } from "./holdings";
import { tradableTokens } from "./arc-tokens";

/**
 * Treasury state.
 *
 * Composition is read from the custody wallet on Arc Testnet - the tokens the
 * treasury actually holds - and priced at read time from live market quotes.
 * NAV snapshots accumulate in the database and the activity log records real
 * events. Nothing served from the dashboard is hardcoded, and no allocation row
 * exists unless a real token backs it.
 */

/** Short display labels for the pinned Arc tokens. */
const ALLOCATION_LABELS: Record<string, string> = {
  USDC: "Liquid reserve",
  EURC: "Euro exposure",
  cirBTC: "Bitcoin exposure",
};

const ALLOCATION_TONES: Record<string, string> = {
  USDC: "cyan",
  EURC: "violet",
  cirBTC: "amber",
};

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

/**
 * How an activity row relates to real money movement.
 *   - "onchain"   a real Arc Testnet transaction settled
 *   - "simulated" internal accounting only; no protocol swap, no transaction
 *   - "system"    governance/control event that moves no funds at all
 */
export type ActivityKind = "onchain" | "simulated" | "system";

/**
 * `kind` defaults to "system" deliberately: understating is the safe failure
 * direction, so a new call site that forgets to pass it can never falsely
 * present itself as an on-chain settlement.
 */
export async function logActivity(
  treasuryId: string,
  title: string,
  detail: string,
  status: string,
  kind: ActivityKind = "system",
): Promise<void> {
  await db.insert(agentActivitiesTable).values({
    id: `act-${randomUUID()}`,
    treasuryId,
    time: new Date(),
    title,
    detail,
    status,
    kind,
  });
}

async function initializeState(
  treasuryId: string,
  quote: MarketQuote,
  signal?: AbortSignal,
): Promise<TreasuryState> {
  // Real mode: the treasury opens EMPTY. Holdings only ever change through
  // real on-chain testnet USDC deposits/withdrawals (wallet routes) and
  // approved rebalances of those funds. The live quote is still required so
  // the stored last-known prices are real from the very first row.
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
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
export async function loadState(treasuryId: string, signal?: AbortSignal): Promise<TreasuryState> {
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
  return initializeState(treasuryId, quote, signal);
}

export interface ComputedDashboard {
  totalValue: number;
  /**
   * Whether totalValue can be trusted. Complete only when every allocation row
   * is a live on-chain balance with a known reference price. An incomplete
   * valuation understates the treasury, which is indistinguishable from a
   * drawdown, so callers must not snapshot it or alert on it.
   */
  valuation: { complete: boolean; note?: string };
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
  allocations: {
    symbol: string;
    name: string;
    percentage: number;
    value: number;
    tone: string;
    /** onchain | accounting | simulated - see the OpenAPI Allocation schema. */
    source: string;
    tradable: boolean;
    units: number;
    untradableReason?: string;
  }[];
  portfolioHistory: { label: string; value: number }[];
  activities: {
    id: string;
    time: string;
    title: string;
    detail: string;
    status: string;
    kind: ActivityKind;
  }[];
  guardrails: { id: string; label: string; value: string; state: string }[];
}

export async function computeDashboard(
  treasuryId: string,
  signal?: AbortSignal,
): Promise<ComputedDashboard> {
  const state = await loadState(treasuryId, signal);
  const [quote, custody] = await Promise.all([
    getMarketQuote(),
    readCustodyHoldings(treasuryId, signal),
  ]);

  const usdcPrice = quote?.usdcUsd ?? state.lastUsdcPrice;

  if (quote && !quote.stale) {
    signal?.throwIfAborted();
    await db
      .update(treasuryStateTable)
      .set({ lastEthPrice: quote.ethUsd, lastUsdcPrice: quote.usdcUsd, updatedAt: new Date() })
      .where(eq(treasuryStateTable.id, treasuryId));
  }

  // Composition is read from the custody wallet, not from stored numbers. When
  // the chain cannot be reached we fall back to the deposit ledger and label
  // the row as such, because "RPC is down" must never render as "treasury is
  // empty".
  const rows = custody.ok
    ? custody.holdings.map((h) => {
        const price = referencePriceFor(h.coingeckoId, quote);
        return {
          symbol: h.symbol,
          name: ALLOCATION_LABELS[h.symbol] ?? h.name,
          units: h.units,
          rawValue: price !== undefined ? h.units * price : 0,
          tone: ALLOCATION_TONES[h.symbol] ?? "cyan",
          source: "onchain",
          tradable: h.tradable,
          ...(h.untradableReason ? { untradableReason: h.untradableReason } : {}),
          role: h.role,
        };
      })
    : [
        {
          symbol: "USDC",
          name: ALLOCATION_LABELS.USDC,
          units: state.usdcUnits,
          rawValue: state.usdcUnits * usdcPrice,
          tone: "cyan",
          source: "accounting",
          tradable: true,
          role: "stable" as const,
        },
      ];

  // A total is only trustworthy when every held asset was read live AND could
  // be priced. Anything less and the figure understates the treasury, so it
  // must not be snapshotted, charted as a change, or read as a drawdown.
  const unpriced = custody.holdings.filter(
    (h) => h.units > 0 && referencePriceFor(h.coingeckoId, quote) === undefined,
  );
  const valuation = custody.ok
    ? unpriced.length === 0
      ? { complete: true }
      : {
          complete: false,
          note: `No reference price for ${unpriced.map((h) => h.symbol).join(", ")}, so those holdings are excluded from the total.`,
        }
    : {
        complete: false,
        note: `Arc could not be read (${custody.error ?? "RPC unreachable"}), so the deposit ledger is shown instead of live balances.`,
      };

  const totalValue = rows.reduce((sum, r) => sum + r.rawValue, 0);

  // An empty treasury has no composition: all percentages are 0, not NaN.
  const pct = (v: number) => (totalValue > 0 ? Math.round((v / totalValue) * 1000) / 10 : 0);
  const sumRole = (role: string) =>
    pct(rows.filter((r) => r.role === role).reduce((sum, r) => sum + r.rawValue, 0));

  const allocations = rows.map(({ rawValue, role: _role, units, ...rest }) => ({
    ...rest,
    percentage: pct(rawValue),
    value: Math.round(rawValue),
    units: Math.round(units * 1e6) / 1e6,
  }));

  // Risk score derived from the actual composition: volatile exposure raises
  // it, and a thin liquid reserve raises it further.
  const liquidPct = sumRole("stable");
  // An empty treasury carries no risk and has nothing deployed.
  const riskScore =
    totalValue > 0
      ? Math.round(Math.min(100, sumRole("risk") * 1.2 + Math.max(0, 25 - liquidPct) * 3))
      : 0;

  // Only a complete valuation may enter NAV history. Snapshotting a degraded
  // read would bake an outage into the chart and let the drawdown monitor
  // raise a critical breach over an RPC blip.
  if (valuation.complete) {
    await maybeSnapshot(treasuryId, totalValue, signal);
  }

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
  // Same reasoning as the snapshot gate: a degraded total would render as a
  // crash against yesterday's healthy reference.
  const dayChange =
    valuation.complete && reference && reference.value > 0
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
    valuation,
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
      kind: row.kind as ActivityKind,
    })),
    guardrails: GUARDRAILS,
  };
}

async function maybeSnapshot(
  treasuryId: string,
  totalValue: number,
  signal?: AbortSignal,
): Promise<void> {
  // Deterministic time-bucket id makes the throttle concurrency-safe:
  // parallel dashboard polls in the same window collide on the primary key
  // and only one snapshot lands per window (per treasury).
  const bucket = Math.floor(Date.now() / SNAPSHOT_THROTTLE_MS);
  signal?.throwIfAborted();
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

/**
 * Symbols a rebalance may name. Only assets Revo can actually route on Arc
 * Testnet qualify - cirBTC is held and priced but has no tradable liquidity, so
 * a policy may never target it.
 */
const REBALANCE_SYMBOLS = tradableTokens().map((t) => t.symbol);

/**
 * Records an approved rebalance target.
 *
 * This used to rewrite four unit columns so the dashboard would show the new
 * split instantly. That was the simulation: no asset moved, and the numbers
 * were the only thing that changed. Composition is now read from the custody
 * wallet, so holdings shift when - and only when - a swap settles on chain.
 *
 * What remains here is validation and the price mark. The approved target is
 * carried by the proposal record itself; this call refuses targets Revo could
 * never execute rather than accepting them and quietly doing nothing.
 *
 * Runs on the caller's executor so the write commits (or rolls back) atomically
 * with the proposal's status transition.
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
  // Mark the book at the prices the approval was judged against. Unit columns
  // are deliberately untouched: the treasury's composition lives on chain and
  // only a settled swap may move it.
  await executor
    .update(treasuryStateTable)
    .set({
      lastEthPrice: quote?.ethUsd ?? state.lastEthPrice,
      lastUsdcPrice: quote?.usdcUsd ?? state.lastUsdcPrice,
      updatedAt: new Date(),
    })
    .where(eq(treasuryStateTable.id, treasuryId));
}
