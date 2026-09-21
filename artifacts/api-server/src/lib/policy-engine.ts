import type { AllocationTarget, PolicyRules } from "@workspace/db";

/**
 * Deterministic policy engine.
 *
 * A natural-language instruction is compiled ONCE (by the LLM) into
 * structured PolicyRules. From then on this engine - not the LLM - decides
 * what the treasury should look like, so stored policies are enforced
 * mechanically and reproducibly.
 */

/** DAO hard cap: no single yield protocol above this %. */
export const HARD_MAX_ALLOCATION_PCT = 35;
/** DAO hard floor: liquid USDC never below this %. */
export const HARD_MIN_LIQUID_RESERVE_PCT = 25;

const RISK_TOLERANCES = ["low", "medium", "high"] as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/**
 * Validates and clamps a raw LLM-compiled rules object into PolicyRules that
 * always respect the DAO hard guardrails. Returns null when the shape is
 * unusable.
 */
export function normalizeRules(raw: {
  maxAllocationPct?: unknown;
  stablecoinReserveMinPct?: unknown;
  drawdownLimitPct?: unknown;
  riskTolerance?: unknown;
}): PolicyRules | null {
  const { maxAllocationPct, stablecoinReserveMinPct, drawdownLimitPct, riskTolerance } = raw;
  if (
    typeof maxAllocationPct !== "number" ||
    typeof stablecoinReserveMinPct !== "number" ||
    typeof drawdownLimitPct !== "number" ||
    typeof riskTolerance !== "string" ||
    !Number.isFinite(maxAllocationPct) ||
    !Number.isFinite(stablecoinReserveMinPct) ||
    !Number.isFinite(drawdownLimitPct)
  ) {
    return null;
  }
  if (!RISK_TOLERANCES.includes(riskTolerance as (typeof RISK_TOLERANCES)[number])) {
    return null;
  }
  return {
    maxAllocationPct: Math.round(clamp(maxAllocationPct, 5, HARD_MAX_ALLOCATION_PCT)),
    stablecoinReserveMinPct: Math.round(clamp(stablecoinReserveMinPct, HARD_MIN_LIQUID_RESERVE_PCT, 80)),
    drawdownLimitPct: Math.round(clamp(drawdownLimitPct, 5, 30)),
    riskTolerance: riskTolerance as PolicyRules["riskTolerance"],
  };
}

/**
 * Size of the directional sleeve by risk tolerance. EURC is the only
 * directional asset in the treasury, so the sleeve is expressed in EURC.
 */
const RISK_SLEEVE_BY_RISK: Record<PolicyRules["riskTolerance"], number> = {
  low: 4,
  medium: 10,
  high: 16,
};

/**
 * Computes the target allocation the stored policy implies. Pure function of
 * the rules - same policy, same targets, every time.
 */
export function computeTargets(rules: PolicyRules): AllocationTarget[] {
  // Directional sleeve sized by risk tolerance, tightened by the drawdown
  // limit, and never above the single-allocation cap.
  const sleeve = Math.min(
    RISK_SLEEVE_BY_RISK[rules.riskTolerance],
    Math.max(0, Math.round(rules.drawdownLimitPct * 0.8)),
    rules.maxAllocationPct,
  );

  const reserveMin = Math.max(rules.stablecoinReserveMinPct, HARD_MIN_LIQUID_RESERVE_PCT);

  // The reserve floor wins over the sleeve whenever the two collide.
  const eurc = Math.min(sleeve, Math.max(0, 100 - reserveMin));

  return [
    { symbol: "USDC", percentage: 100 - eurc },
    { symbol: "EURC", percentage: eurc },
  ];
}

export interface RebalancePlan {
  targets: AllocationTarget[];
  action: string;
  safetyChecks: string[];
}

/**
 * Compares the current allocations to the policy targets and, when they
 * meaningfully differ, returns a fully-described rebalance plan. Returns null
 * when the portfolio is already compliant (no proposal needed).
 */
export function buildRebalancePlan(
  rules: PolicyRules,
  current: { symbol: string; percentage: number }[],
): RebalancePlan | null {
  const targets = computeTargets(rules);
  const currentBySymbol = new Map(current.map((a) => [a.symbol, a.percentage]));

  const shifts = targets
    .map((t) => {
      const from = currentBySymbol.get(t.symbol) ?? 0;
      return { symbol: t.symbol, from, to: t.percentage, delta: t.percentage - from };
    })
    .filter((s) => Math.abs(s.delta) >= 1);

  if (shifts.length === 0) {
    return null;
  }

  const action = shifts
    .map(
      (s) =>
        `${s.symbol}: ${s.from}% \u2192 ${s.to}% (${s.delta > 0 ? "+" : ""}${Math.round(s.delta * 10) / 10}pt)`,
    )
    .join(" \u00b7 ");

  const reserveMin = Math.max(rules.stablecoinReserveMinPct, HARD_MIN_LIQUID_RESERVE_PCT);
  const sleeveTarget = targets.find((t) => t.symbol === "EURC")?.percentage ?? 0;

  return {
    targets,
    action: `Rebalance to policy targets: ${action}`,
    safetyChecks: [
      `Single-allocation cap ${rules.maxAllocationPct}% enforced (DAO hard cap ${HARD_MAX_ALLOCATION_PCT}%)`,
      `Stablecoin reserve floor ${reserveMin}% maintained after rebalance`,
      `Drawdown limit ${rules.drawdownLimitPct}% respected, directional sleeve sized to ${sleeveTarget}%`,
    ],
  };
}
