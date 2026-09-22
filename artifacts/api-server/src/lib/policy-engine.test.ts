/**
 * The policy engine is the deterministic half of policy compilation: the
 * model proposes rule values once, and everything an approval is made of
 * comes from these pure functions. These tests pin down how the sleeve is
 * split across risk assets, because a split that quietly enlarged the sleeve
 * or routed weight to a token Revo refuses to trade would be a policy breach
 * dressed up as arithmetic.
 */
import { describe, expect, it } from "vitest";
import type { PolicyRules } from "@workspace/db";
import { ARC_TOKENS, tradableRiskTokens } from "./arc-tokens";
import {
  buildRebalancePlan,
  computeTargets,
  normalizeRules,
  normalizeSleeveWeights,
  sleeveSizePct,
} from "./policy-engine";

const MEDIUM: PolicyRules = {
  maxAllocationPct: 20,
  stablecoinReserveMinPct: 40,
  drawdownLimitPct: 15,
  riskTolerance: "medium",
};

describe("sleeve weights", () => {
  it("keeps only tradable risk symbols and scales what is left to 100", () => {
    const weights = normalizeSleeveWeights({
      EURC: 1,
      cirBTC: 1,
      wARS: 5, // held, never traded
      NVDA: 5, // not a pinned token at all
      USDC: 50, // the reserve is not part of the sleeve
      WETH: -3, // nonsense
      syrupUSDC: 2,
    });
    expect(weights).toEqual({ EURC: 25, cirBTC: 25, syrupUSDC: 50 });
  });

  it("falls back to the default split when nothing usable was given", () => {
    expect(normalizeSleeveWeights(undefined)).toBeUndefined();
    expect(normalizeSleeveWeights({ wARS: 100 })).toBeUndefined();
    expect(normalizeSleeveWeights([1, 2])).toBeUndefined();
    expect(normalizeRules({ ...MEDIUM, sleeveWeights: { NVDA: 1 } })?.sleeveWeights).toBeUndefined();
  });
});

describe("computeTargets", () => {
  it("puts the whole sleeve in EURC for a policy written before other assets existed", () => {
    expect(computeTargets(MEDIUM)).toEqual([
      { symbol: "USDC", percentage: 90 },
      { symbol: "EURC", percentage: 10 },
    ]);
  });

  it("splits the sleeve by weight without changing its size or the reserve", () => {
    const rules: PolicyRules = { ...MEDIUM, sleeveWeights: { EURC: 50, cirBTC: 30, WETH: 20 } };
    const targets = computeTargets(rules);
    const risk = targets.filter((t) => t.symbol !== "USDC");
    expect(risk.reduce((sum, t) => sum + t.percentage, 0)).toBe(sleeveSizePct(rules));
    expect(targets.reduce((sum, t) => sum + t.percentage, 0)).toBe(100);
    expect(targets).toEqual([
      { symbol: "USDC", percentage: 90 },
      { symbol: "EURC", percentage: 5 },
      { symbol: "cirBTC", percentage: 3 },
      { symbol: "WETH", percentage: 2 },
    ]);
  });

  it("rounds by largest remainder so the split still sums to the sleeve", () => {
    // 10% across three equal weights is 3.33 each: two get 3, one gets 4.
    const targets = computeTargets({ ...MEDIUM, sleeveWeights: { EURC: 1, cirBTC: 1, WETH: 1 } });
    const risk = targets.filter((t) => t.symbol !== "USDC").map((t) => t.percentage);
    expect(risk.reduce((a, b) => a + b, 0)).toBe(10);
    expect(risk.every((p) => Number.isInteger(p))).toBe(true);
    expect(targets[0]).toEqual({ symbol: "USDC", percentage: 90 });
  });

  it("never sizes a sleeve in a token Revo will not trade", () => {
    const targets = computeTargets({ ...MEDIUM, sleeveWeights: { wARS: 100, EURC: 1 } });
    expect(targets.map((t) => t.symbol)).not.toContain("wARS");
    expect(targets).toEqual([
      { symbol: "USDC", percentage: 90 },
      { symbol: "EURC", percentage: 10 },
    ]);
    for (const t of targets) {
      expect(t.symbol === "USDC" || tradableRiskTokens().some((r) => r.symbol === t.symbol)).toBe(true);
    }
  });

  it("breaks a remainder tie by registry order, not by how the weights were keyed", () => {
    // 10% over three equal weights: the extra point goes to the earliest
    // registry entry (EURC) however the object was written.
    const a = computeTargets({ ...MEDIUM, sleeveWeights: { WETH: 1, cirBTC: 1, EURC: 1 } });
    const b = computeTargets({ ...MEDIUM, sleeveWeights: { EURC: 1, cirBTC: 1, WETH: 1 } });
    expect(a).toEqual(b);
    expect(a.find((t) => t.symbol === "EURC")?.percentage).toBe(4);
  });

  it("lists risk assets in registry order whatever order the weights came in", () => {
    const targets = computeTargets({ ...MEDIUM, sleeveWeights: { WETH: 1, EURC: 1 } });
    const order = Object.keys(ARC_TOKENS);
    const symbols = targets.slice(1).map((t) => t.symbol);
    expect(symbols).toEqual([...symbols].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  });
});

describe("buildRebalancePlan", () => {
  it("writes an explicit zero target for a tradable asset the policy no longer names", () => {
    const plan = buildRebalancePlan(MEDIUM, [
      { symbol: "USDC", percentage: 80 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "cirBTC", percentage: 10 },
    ]);
    expect(plan).not.toBeNull();
    expect(plan!.targets).toContainEqual({ symbol: "cirBTC", percentage: 0 });
    expect(plan!.action).toContain("cirBTC: 10% \u2192 0%");
  });

  it("carries an untradable holding at its current share instead of proposing to sell it", () => {
    const plan = buildRebalancePlan(MEDIUM, [
      { symbol: "USDC", percentage: 85 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "wARS", percentage: 5 },
    ]);
    // wARS is 5% of the book the engine cannot move. It comes out of the
    // 10% sleeve: 5 is left for EURC, USDC keeps its 90, and the targets
    // still sum to 100 without pretending wARS can be sold.
    expect(plan).not.toBeNull();
    expect(plan!.targets).toEqual([
      { symbol: "USDC", percentage: 90 },
      { symbol: "EURC", percentage: 5 },
      { symbol: "wARS", percentage: 5 },
    ]);
    expect(plan!.heldOnly).toEqual(["wARS"]);
    expect(plan!.liquidations).toEqual([]);
    expect(plan!.action).not.toContain("wARS");
    expect(plan!.safetyChecks.some((c) => c.startsWith("wARS 5% held, not traded"))).toBe(true);
  });

  it("does not propose anything when only the held-only share has drifted", () => {
    // USDC 90 / EURC 5 sits on the policy; wARS drifting to 5.4 is not drift
    // the engine can act on, so no proposal is raised for it.
    const plan = buildRebalancePlan(MEDIUM, [
      { symbol: "USDC", percentage: 89.6 },
      { symbol: "EURC", percentage: 5 },
      { symbol: "wARS", percentage: 5.4 },
    ]);
    expect(plan).toBeNull();
  });

  it("gives the reserve whatever a held-only share leaves once it exceeds the sleeve", () => {
    const plan = buildRebalancePlan(MEDIUM, [
      { symbol: "USDC", percentage: 70 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "wARS", percentage: 20 },
    ]);
    // The sleeve is gone, so the EURC still held is an explicit sale, and one
    // the operator must approve themselves even in Autonomous mode.
    expect(plan!.targets).toEqual([
      { symbol: "USDC", percentage: 80 },
      { symbol: "wARS", percentage: 20 },
      { symbol: "EURC", percentage: 0 },
    ]);
    expect(plan!.liquidations).toEqual(["EURC"]);
  });

  it("names the implicit liquidation so autonomous approval can be withheld from it", () => {
    const plan = buildRebalancePlan(MEDIUM, [
      { symbol: "USDC", percentage: 80 },
      { symbol: "EURC", percentage: 10 },
      { symbol: "cirBTC", percentage: 10 },
    ]);
    expect(plan!.liquidations).toEqual(["cirBTC"]);
    expect(plan!.safetyChecks.some((c) => c.includes("Sells cirBTC down to zero"))).toBe(true);
  });

  it("describes the split in the safety checks when the sleeve spans assets", () => {
    const plan = buildRebalancePlan({ ...MEDIUM, sleeveWeights: { EURC: 1, WETH: 1 } }, [
      { symbol: "USDC", percentage: 100 },
    ]);
    expect(plan?.safetyChecks.some((c) => c.includes("EURC 5%") && c.includes("WETH 5%"))).toBe(true);
  });
});
