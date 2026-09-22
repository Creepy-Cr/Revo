import type { AllocationTarget, PolicyRules } from "@workspace/db";
import { ARC_TOKENS, tradableRiskTokens } from "./arc-tokens";

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
  sleeveWeights?: unknown;
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
  const sleeveWeights = normalizeSleeveWeights(raw.sleeveWeights);
  return {
    maxAllocationPct: Math.round(clamp(maxAllocationPct, 5, HARD_MAX_ALLOCATION_PCT)),
    stablecoinReserveMinPct: Math.round(clamp(stablecoinReserveMinPct, HARD_MIN_LIQUID_RESERVE_PCT, 80)),
    drawdownLimitPct: Math.round(clamp(drawdownLimitPct, 5, 30)),
    riskTolerance: riskTolerance as PolicyRules["riskTolerance"],
    ...(sleeveWeights ? { sleeveWeights } : {}),
  };
}

/**
 * Keeps only weights that name a risk asset Revo will actually trade, as
 * positive finite numbers scaled to sum to 100. Anything else (an unknown
 * symbol, a token Revo holds but refuses to trade, a negative weight) is
 * dropped rather than clamped: a compiler that names a token this treasury
 * cannot route must not silently get a different token instead. Returns
 * undefined when nothing usable remains, which means "the default split".
 */
export function normalizeSleeveWeights(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const allowed = new Set(tradableRiskTokens().map((t) => t.symbol));
  const kept: [string, number][] = [];
  for (const [symbol, weight] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(symbol)) continue;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) continue;
    kept.push([symbol, weight]);
  }
  if (kept.length === 0) return undefined;
  const total = kept.reduce((sum, [, w]) => sum + w, 0);
  return Object.fromEntries(kept.map(([symbol, w]) => [symbol, (w / total) * 100]));
}

/**
 * Size of the whole directional sleeve by risk tolerance, as a share of the
 * treasury. The sleeve is then split across risk assets by the policy's
 * weights; the split never enlarges it.
 */
const RISK_SLEEVE_BY_RISK: Record<PolicyRules["riskTolerance"], number> = {
  low: 4,
  medium: 10,
  high: 16,
};

/** The split a policy without explicit weights means: the whole sleeve in EURC. */
export const DEFAULT_SLEEVE_WEIGHTS: Readonly<Record<string, number>> = { EURC: 100 };

/** Total sleeve size implied by the rules, before it is split across assets. */
export function sleeveSizePct(rules: PolicyRules): number {
  // Directional sleeve sized by risk tolerance, tightened by the drawdown
  // limit, and never above the single-allocation cap.
  const sleeve = Math.min(
    RISK_SLEEVE_BY_RISK[rules.riskTolerance],
    Math.max(0, Math.round(rules.drawdownLimitPct * 0.8)),
    rules.maxAllocationPct,
  );
  const reserveMin = Math.max(rules.stablecoinReserveMinPct, HARD_MIN_LIQUID_RESERVE_PCT);
  // The reserve floor wins over the sleeve whenever the two collide.
  return Math.min(sleeve, Math.max(0, 100 - reserveMin));
}

const registryIndex = (symbol: string): number => Object.keys(ARC_TOKENS).indexOf(symbol);

/**
 * Held-only positions: tokens the treasury holds and values but Revo never
 * trades. Their share of the book is whatever it is, so a target that
 * pretends otherwise can never be reached. They are carried as fixed targets
 * at their current whole-percentage share and the policy is applied to the
 * rest of the book.
 */
function heldOnlyShares(current: { symbol: string; percentage: number }[]): AllocationTarget[] {
  return current
    .filter((a) => {
      const token = ARC_TOKENS[a.symbol];
      return token !== undefined && !token.tradable && a.percentage >= 0.5;
    })
    .map((a) => ({ symbol: a.symbol, percentage: Math.round(a.percentage) }))
    .sort((a, b) => registryIndex(a.symbol) - registryIndex(b.symbol));
}

/**
 * Computes the target allocation the stored policy implies. Pure function of
 * the rules and of the held-only share - same policy, same book, same
 * targets, every time.
 *
 * Whole percentages only, so the split is done by largest remainder: the
 * sleeve total is preserved exactly and the reserve absorbs nothing but what
 * the rules gave it. A weight for a token that is no longer tradable is
 * dropped at compute time too, so a token Revo stops trading falls out of
 * every target the next time the engine runs rather than lingering.
 *
 * A held-only position comes out of the risk sleeve first: the reserve floor
 * is a floor on the whole book. When the held-only share alone exceeds the
 * sleeve, the tradable sleeve is zero and the reserve takes what is left.
 */
export function computeTargets(
  rules: PolicyRules,
  current: { symbol: string; percentage: number }[] = [],
): AllocationTarget[] {
  const heldOnly = heldOnlyShares(current);
  const heldOnlyTotal = heldOnly.reduce((sum, h) => sum + h.percentage, 0);
  const sleeve = Math.max(0, sleeveSizePct(rules) - heldOnlyTotal);
  const tradable = new Set(tradableRiskTokens().map((t) => t.symbol));
  const weights = Object.entries(rules.sleeveWeights ?? DEFAULT_SLEEVE_WEIGHTS).filter(
    ([symbol, w]) => tradable.has(symbol) && Number.isFinite(w) && w > 0,
  );
  const weightTotal = weights.reduce((sum, [, w]) => sum + w, 0);

  const split: { symbol: string; percentage: number; remainder: number }[] =
    weightTotal > 0
      ? weights.map(([symbol, w]) => {
          const exact = (sleeve * w) / weightTotal;
          return { symbol, percentage: Math.floor(exact), remainder: exact - Math.floor(exact) };
        })
      : [];
  let leftover = sleeve - split.reduce((sum, s) => sum + s.percentage, 0);
  // Largest remainder first; equal remainders go to the earlier registry
  // entry, so the winner never depends on how the weights object was keyed.
  const byRemainder = [...split].sort(
    (a, b) => b.remainder - a.remainder || registryIndex(a.symbol) - registryIndex(b.symbol),
  );
  for (const s of byRemainder) {
    if (leftover <= 0) break;
    s.percentage += 1;
    leftover -= 1;
  }

  const risk = split
    .filter((s) => s.percentage > 0)
    // Registry order, so the same policy always lists the same way.
    .sort((a, b) => registryIndex(a.symbol) - registryIndex(b.symbol))
    .map(({ symbol, percentage }) => ({ symbol, percentage }));
  const riskTotal = risk.reduce((sum, r) => sum + r.percentage, 0);

  return [{ symbol: "USDC", percentage: 100 - riskTotal - heldOnlyTotal }, ...risk, ...heldOnly];
}

export interface RebalancePlan {
  targets: AllocationTarget[];
  action: string;
  safetyChecks: string[];
  /**
   * Tradable risk assets the policy does not name but the treasury holds, so
   * the plan sells them down to zero. Auto-approval must not cover these: a
   * sale the policy never mentions is not "inside the policy".
   */
  liquidations: string[];
  /** Held-only positions carried at their current share, never traded. */
  heldOnly: string[];
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
  const policyTargets = computeTargets(rules, current);
  const currentBySymbol = new Map(current.map((a) => [a.symbol, a.percentage]));

  // Percentages are shares of the whole book, so a tradable risk asset the
  // policy no longer names has an implied target of zero. It is written out
  // explicitly so the approval says what will be sold, not just what will be
  // bought.
  const named = new Set(policyTargets.map((t) => t.symbol));
  const implicitZero = tradableRiskTokens()
    .filter((t) => !named.has(t.symbol) && (currentBySymbol.get(t.symbol) ?? 0) >= 1)
    .map((t) => ({ symbol: t.symbol, percentage: 0 }));
  const targets = [...policyTargets, ...implicitZero];
  const heldOnly = targets.filter((t) => ARC_TOKENS[t.symbol]?.tradable === false).map((t) => t.symbol);

  const shifts = targets
    .map((t) => {
      const from = currentBySymbol.get(t.symbol) ?? 0;
      return { symbol: t.symbol, from, to: t.percentage, delta: t.percentage - from };
    })
    // A held-only position cannot be moved, so it never counts as drift.
    .filter((s) => Math.abs(s.delta) >= 1 && !heldOnly.includes(s.symbol));

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
  const sleeveTarget = targets
    .filter((t) => t.symbol !== "USDC" && !heldOnly.includes(t.symbol))
    .reduce((sum, t) => sum + t.percentage, 0);

  const heldOnlyNote = heldOnly.map((symbol) => {
    const token = ARC_TOKENS[symbol]!;
    return `${symbol} ${targets.find((t) => t.symbol === symbol)?.percentage ?? 0}% held, not traded: ${token.untradableReason ?? "Revo does not trade it"}`;
  });
  const liquidations = implicitZero.map((t) => t.symbol);
  const tradableTargets = targets.filter((t) => t.symbol !== "USDC" && !heldOnly.includes(t.symbol));

  return {
    targets,
    action: `Rebalance to policy targets: ${action}`,
    safetyChecks: [
      `Single-allocation cap ${rules.maxAllocationPct}% enforced (DAO hard cap ${HARD_MAX_ALLOCATION_PCT}%)`,
      `Stablecoin reserve floor ${reserveMin}% maintained after rebalance`,
      `Drawdown limit ${rules.drawdownLimitPct}% respected, directional sleeve sized to ${sleeveTarget}%${
        tradableTargets.length > 1
          ? ` across ${tradableTargets.map((t) => `${t.symbol} ${t.percentage}%`).join(", ")}`
          : ""
      }`,
      ...(liquidations.length > 0
        ? [
            `Sells ${liquidations.join(", ")} down to zero because the policy targets leave ${liquidations.length === 1 ? "it" : "them"} nothing; this sale needs an operator's approval even in Autonomous mode`,
          ]
        : []),
      ...heldOnlyNote,
    ],
    liquidations,
    heldOnly,
  };
}
