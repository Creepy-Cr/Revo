import { randomUUID } from "node:crypto";

/**
 * Simulated protocol-hack safety drill.
 *
 * The drill is a deterministic, time-driven state machine kept entirely in
 * memory. Starting it records a timestamp; every phase and number below is
 * derived from elapsed time on each poll, and resetting simply clears the
 * timestamp - nothing is persisted, so the baseline state returns untouched.
 */

export type DrillPhase = "idle" | "alert" | "proposal" | "rotating" | "secured";

/**
 * Structural mirror of ActivityKind in ./state, kept local so this simulation
 * module stays self-contained. The two must stay identical; if they drift,
 * applyDrillToDashboard stops accepting a real dashboard and typecheck fails.
 */
type ActivityKind = "onchain" | "simulated" | "system";

const ALERT_END_MS = 3_000;
const PROPOSAL_END_MS = 6_000;
const ROTATION_END_MS = 12_000;

interface DrillRuntime {
  startedAt: number;
  proposalId: string;
}

/** Per-treasury drill runtimes - one tenant's drill never leaks into another's view. */
const runtimes = new Map<string, DrillRuntime>();

export interface DrillStatusPayload {
  active: boolean;
  phase: DrillPhase;
  progress: number;
  startedAt: string | null;
}

export function startDrill(treasuryId: string): DrillStatusPayload {
  if (!runtimes.has(treasuryId)) {
    runtimes.set(treasuryId, {
      startedAt: Date.now(),
      proposalId: `revo-drill-${randomUUID().slice(0, 8)}`,
    });
  }
  return getDrillStatus(treasuryId);
}

export function resetDrill(treasuryId: string): DrillStatusPayload {
  runtimes.delete(treasuryId);
  return getDrillStatus(treasuryId);
}

function phaseForElapsed(elapsed: number): DrillPhase {
  if (elapsed < ALERT_END_MS) return "alert";
  if (elapsed < PROPOSAL_END_MS) return "proposal";
  if (elapsed < ROTATION_END_MS) return "rotating";
  return "secured";
}

export function getDrillStatus(treasuryId: string): DrillStatusPayload {
  const runtime = runtimes.get(treasuryId);
  if (!runtime) {
    return { active: false, phase: "idle", progress: 0, startedAt: null };
  }
  const elapsed = Date.now() - runtime.startedAt;
  return {
    active: true,
    phase: phaseForElapsed(elapsed),
    progress: Math.min(100, Math.round((elapsed / ROTATION_END_MS) * 100)),
    startedAt: new Date(runtime.startedAt).toISOString(),
  };
}

/** 0 before rotation starts, 0..1 while rotating, 1 once secured. */
function rotationProgress(elapsed: number): number {
  if (elapsed <= PROPOSAL_END_MS) return 0;
  if (elapsed >= ROTATION_END_MS) return 1;
  return (elapsed - PROPOSAL_END_MS) / (ROTATION_END_MS - PROPOSAL_END_MS);
}

interface AllocationLike {
  symbol: string;
  name: string;
  percentage: number;
  value: number;
  tone: string;
}

interface DashboardLike {
  totalValue: number;
  dayChange: number;
  deployed: number;
  riskScore: number;
  status: string;
  network: string;
  allocations: AllocationLike[];
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

/** Target allocation once the emergency exit completes. */
const SAFE_TARGETS: Record<string, number> = {
  USDC: 30,
  aUSDC: 0,
  sUSDC: 70,
  ETH: 0,
};

const lerp = (from: number, to: number, r: number) => from + (to - from) * r;

export function applyDrillToDashboard<T extends DashboardLike>(
  treasuryId: string,
  baseline: T,
): T & { drill: DrillStatusPayload } {
  const status = getDrillStatus(treasuryId);
  const runtime = runtimes.get(treasuryId);
  if (!runtime || !status.active) {
    return { ...baseline, drill: status };
  }

  // Defense in depth: with an empty treasury there is nothing to rotate, so
  // the overlay must not fabricate risk scores, deployment, or day-change.
  if (baseline.totalValue <= 0) {
    return { ...baseline, drill: status };
  }

  const elapsed = Date.now() - runtime.startedAt;
  const phase = status.phase;
  const r = rotationProgress(elapsed);

  // Small simulated slippage while the emergency rotation executes,
  // proportional to the real portfolio size (~0.17% of NAV).
  const totalValue = Math.round(baseline.totalValue - baseline.totalValue * 0.0017 * r);

  const allocations = baseline.allocations.map((alloc) => {
    const target = SAFE_TARGETS[alloc.symbol] ?? alloc.percentage;
    const percentage = Math.round(lerp(alloc.percentage, target, r) * 10) / 10;
    return {
      ...alloc,
      percentage,
      value: Math.round((totalValue * percentage) / 100),
      name:
        alloc.symbol === "sUSDC" && r === 1
          ? "USDC safe reserve: funds secured"
          : alloc.name,
    };
  });

  // The market prices in the (simulated) exploit, then stabilizes as the
  // treasury exits cleanly. The dip scales with the real portfolio (~0.5%).
  const dip = baseline.totalValue * 0.005;
  const dipValue =
    phase === "alert" || phase === "proposal"
      ? Math.round(baseline.totalValue - dip)
      : Math.round(lerp(baseline.totalValue - dip, totalValue, r));
  const portfolioHistory = [...baseline.portfolioHistory, { label: "DRILL", value: dipValue }];

  const riskScore = Math.round(lerp(88, 12, r));

  const guardrails = baseline.guardrails.map((g) =>
    g.id === "g-3"
      ? {
          ...g,
          value: phase === "secured" ? "Risk 80+" : "TRIPPED @ 88",
          state: phase === "secured" ? "active" : "violated",
        }
      : g,
  );

  const statusLabel =
    phase === "alert"
      ? "ALERT"
      : phase === "proposal"
        ? "EMERGENCY"
        : phase === "rotating"
          ? "ROTATING"
          : "SAFE MODE";

  return {
    ...baseline,
    totalValue,
    dayChange: phase === "secured" ? -0.17 : -0.5,
    deployed: Math.round(lerp(baseline.deployed, 5, r)),
    riskScore,
    status: statusLabel,
    allocations,
    portfolioHistory,
    activities: [...drillActivities(runtime, elapsed), ...baseline.activities],
    guardrails,
    drill: status,
  };
}

function drillActivities(runtime: DrillRuntime, elapsed: number) {
  const start = runtime.startedAt;
  const iso = (offset: number) => new Date(start + offset).toISOString();
  const secured = elapsed >= ROTATION_END_MS;

  // Every drill event is theatre by definition: the overlay never touches the
  // chain. They are all "simulated" so the console badges them as such.
  const events: {
    id: string;
    time: string;
    title: string;
    detail: string;
    status: string;
    kind: ActivityKind;
  }[] = [];

  events.push({
    id: "drill-alert",
    time: iso(0),
    title: "DRILL: Critical exploit alert received",
    detail:
      "Security feeds flag an active exploit draining the Arc lending vault. New deployments frozen instantly. (Simulated drill signal, no real event.)",
    status: "error",
    kind: "simulated",
  });

  if (elapsed >= ALERT_END_MS) {
    events.push({
      id: "drill-proposal",
      time: iso(ALERT_END_MS),
      title: "Emergency exit proposal drafted",
      detail:
        "Risk score 88 breached the 'Emergency exit threshold (Risk 80+)' guardrail. Agent auto-drafted a rotation of all at-risk capital into the USDC safe reserve.",
      status: elapsed >= PROPOSAL_END_MS ? "executed" : "processing",
      kind: "simulated",
    });
  }

  if (elapsed >= PROPOSAL_END_MS) {
    events.push({
      id: "drill-rotating",
      time: iso(PROPOSAL_END_MS),
      title: "Rotating funds to USDC safe reserve",
      detail:
        "Unwinding the aUSDC lending position and ETH sleeve into sUSDC/USDC inside the guarded testnet simulation.",
      status: secured ? "executed" : "processing",
      kind: "simulated",
    });
  }

  if (secured) {
    events.push({
      id: "drill-secured",
      time: iso(ROTATION_END_MS),
      title: "Funds secured. Drill complete",
      detail:
        "100% of at-risk capital now sits in the USDC safe reserve. Treasury holds in safe mode until the drill is reset.",
      status: "verified",
      kind: "simulated",
    });
  }

  // Newest first, matching the activity feed's ordering.
  return events.reverse();
}

export function drillSignal(treasuryId: string) {
  const runtime = runtimes.get(treasuryId);
  if (!runtime) return null;
  return {
    id: "sig-drill",
    asset: "aUSDC",
    score: 8,
    direction: "sell",
    title: "DRILL: Active exploit on Arc lending vault",
    sources: ["Security feeds", "On-chain", "Governance"],
    confidence: 96,
    time: new Date(runtime.startedAt).toISOString(),
    detail:
      "Simulated drill signal: attacker draining vault liquidity, oracle deviation 4.7σ. Policy mandates immediate exit of all exposed positions.",
    components: [
      {
        source: "Security feeds",
        label: "Exploit alert",
        score: -96,
        weight: 0.5,
        detail: "Drill scenario: active exploit flagged draining Arc lending vault liquidity (simulated).",
      },
      {
        source: "On-chain",
        label: "Oracle deviation",
        score: -84,
        weight: 0.3,
        detail: "Drill scenario: vault oracle deviating 4.7σ from reference pricing (simulated).",
      },
      {
        source: "Governance",
        label: "Emergency mandate",
        score: -60,
        weight: 0.2,
        detail: "DAO mandate pre-authorizes immediate exit when the Risk 80+ threshold trips.",
      },
    ],
  };
}

export function drillProposal(treasuryId: string) {
  const runtime = runtimes.get(treasuryId);
  if (!runtime) return null;
  const elapsed = Date.now() - runtime.startedAt;
  if (elapsed < ALERT_END_MS) return null;

  const status =
    elapsed >= ROTATION_END_MS ? "EXECUTED" : elapsed >= PROPOSAL_END_MS ? "EXECUTING" : "PENDING";

  return {
    id: runtime.proposalId,
    title: "[DRILL] Emergency exit to USDC safe reserve",
    summary:
      "A critical exploit signal on the Arc lending vault breached the Risk 80+ emergency threshold. Per the DAO mandate, the agent rotates every at-risk position into the whitelisted USDC safe reserve.",
    status,
    createdAt: new Date(runtime.startedAt + ALERT_END_MS).toISOString(),
    action:
      "Rotate 34% aUSDC and 13% ETH into the safe reserve. Target: 70% sUSDC, 30% liquid USDC. Freeze all new deployments until all-clear.",
    safetyChecks: [
      "Emergency exit threshold (Risk 80+) breached. Auto-exit pre-authorized by DAO mandate",
      "Destination restricted to the whitelisted USDC safe reserve",
      "Testnet drill only. No mainnet keys, no real funds moved",
    ],
    command: "SYSTEM DRILL: simulated protocol exploit response",
  };
}
