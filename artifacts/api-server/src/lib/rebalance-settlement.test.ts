/**
 * Recovery of an approved rebalance whose settlement outlived its request.
 *
 * Approval returns before the swap confirms, so something has to finish the
 * job when the process that started it does not. These tests pin the two
 * halves of that contract: the settlement records its hash before broadcast
 * and gives up the send if it loses its claim, and reconciliation resolves a
 * stranded proposal from the chain WITHOUT ever signing or sending anything.
 *
 * The chain is stubbed so the decisions are what is under test. The database
 * is the real development one, so every treasury id is unique to a run and
 * the rows are cleaned up afterwards.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentActivitiesTable,
  policiesTable,
  securityControlsTable,
  treasurySettingsTable,
  treasuryStateTable,
  alertsTable,
  auditEventsTable,
  db,
  treasuriesTable,
  treasuryProposalsTable,
} from "@workspace/db";

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

const settleRebalance = vi.fn();
const planRebalanceLeg = vi.fn();
const readSettledOutcome = vi.fn();
const readFillFromReceipt = vi.fn();
const getTransferRecoveryStatus = vi.fn();

// `describeHoldings` stays real: the operator-facing copy is part of what
// these tests are checking, not something worth restating in a stub.
vi.mock("./rebalance-execution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rebalance-execution")>();
  return { ...actual, planRebalanceLeg, settleRebalance, readSettledOutcome, readFillFromReceipt };
});

vi.mock("./arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arc-chain")>();
  return { ...actual, getTransferRecoveryStatus };
});

const {
  drainProposalSettlements,
  reconcileApprovedProposals,
  settleApprovedProposal,
  startProposalSettlement,
} = await import("./rebalance-settlement");

const TX_HASH = `0x${"ab".repeat(32)}`;
const TARGETS = [
  { symbol: "USDC", percentage: 50 },
  { symbol: "EURC", percentage: 50 },
];

/**
 * A settled swap as `settleRebalance` returns one: the quote it was signed
 * against, and the fill that actually came back read from the wallet.
 */
function settled(overrides: Record<string, unknown> = {}) {
  return {
    kind: "settled",
    settlement: {
      txHash: TX_HASH,
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amountIn: "500",
      expectedOutput: "425",
      minOutput: "422.875",
      feeTier: 3000,
      explorerUrl: `https://explorer/${TX_HASH}`,
      realisedOutput: "424.15",
      realisedSlippagePct: 0.2,
      gasCostUsdc: "0.005696",
      holdingsAfter: [
        { symbol: "USDC", units: "499.98992", percentage: 50.4 },
        { symbol: "EURC", units: "424.15", percentage: 49.6 },
      ],
      ...overrides,
    },
  };
}

const treasuryIds: string[] = [];
let treasuryId: string;

async function seedProposal(
  overrides: Partial<typeof treasuryProposalsTable.$inferInsert> = {},
): Promise<string> {
  const id = `prop-${randomUUID()}`;
  await db.insert(treasuryProposalsTable).values({
    id,
    treasuryId,
    title: "Rotate into EURC",
    summary: "Move half the book into the euro sleeve.",
    status: "approved",
    action: "50% USDC / 50% EURC",
    safetyChecks: ["Simulated against live balances"],
    command: "rebalance to 50/50",
    targetAllocations: TARGETS,
    decidedAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  });
  return id;
}

async function proposal(id: string) {
  const [row] = await db
    .select()
    .from(treasuryProposalsTable)
    .where(eq(treasuryProposalsTable.id, id));
  return row!;
}

async function activities() {
  return db.select().from(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, treasuryId));
}

async function alerts() {
  return db.select().from(alertsTable).where(eq(alertsTable.treasuryId, treasuryId));
}

beforeEach(async () => {
  // Reset, not clear: a queued one-shot value left behind by a failing test
  // must not become the next test's planner answer.
  vi.resetAllMocks();
  // Nothing readable unless a test says otherwise: the default must be the
  // degraded read, so no test passes by accident on invented balances.
  readSettledOutcome.mockResolvedValue({
    realisedOutput: null,
    realisedSlippagePct: null,
    holdingsAfter: [],
  });
  readFillFromReceipt.mockResolvedValue(null);
  // A single-leg target by default: the leg that settled was the whole job.
  planRebalanceLeg.mockResolvedValue({ kind: "nothing-to-do", reason: "on target" });
  treasuryId = `test-rebalance-${randomUUID()}`;
  treasuryIds.push(treasuryId);
  await db.insert(treasuriesTable).values({
    id: treasuryId,
    name: "Rebalance settlement test",
    ownerWallet: `0x${randomUUID().replace(/-/g, "")}`,
  });
});

afterAll(async () => {
  for (const id of treasuryIds) {
    await db.delete(alertsTable).where(eq(alertsTable.treasuryId, id));
    await db.delete(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, id));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, id));
    await db.delete(treasuryProposalsTable).where(eq(treasuryProposalsTable.treasuryId, id));
    await db.delete(policiesTable).where(eq(policiesTable.treasuryId, id));
    await db.delete(securityControlsTable).where(eq(securityControlsTable.id, id));
    await db.delete(treasuryStateTable).where(eq(treasuryStateTable.id, id));
    await db.delete(treasurySettingsTable).where(eq(treasurySettingsTable.id, id));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, id));
  }
});

describe("settling an approved proposal", () => {
  it("records the swap hash before the swap is broadcast", async () => {
    const id = await seedProposal({ executionTxHash: null });
    let hashAtBroadcastTime: string | null = null;

    settleRebalance.mockImplementation(async (_t, _targets, _quote, claim) => {
      // Exactly the moment before the send: whatever is durable now is all a
      // reconciler would have to work with if this process died here.
      await claim(TX_HASH, db);
      hashAtBroadcastTime = (await proposal(id)).executionTxHash;
      return settled();
    });

    const result = await settleApprovedProposal(treasuryId, await proposal(id), null);

    expect(hashAtBroadcastTime).toBe(TX_HASH);
    expect(result.kind).toBe("executed");
    expect(await proposal(id)).toMatchObject({ status: "executed", executionTxHash: TX_HASH });
  });

  it("logs what the rebalance achieved, not only what it aimed for", async () => {
    const id = await seedProposal({ executionTxHash: null });
    settleRebalance.mockResolvedValue(settled());

    await settleApprovedProposal(treasuryId, await proposal(id), null);

    const [logged] = await activities();
    expect(logged).toMatchObject({ title: "Rebalance settled on Arc", txHash: TX_HASH });
    // The fill leads, the quote is what it is measured against.
    expect(logged!.detail).toContain("received 424.15 EURC");
    expect(logged!.detail).toContain("against a quote of 425");
    expect(logged!.detail).toContain("Realised slippage was 0.20% below the quote.");
    // Where the book actually landed, beside the 50/50 that was approved.
    expect(logged!.detail).toContain(
      "The treasury now holds 499.98992 USDC (50.4%) and 424.15 EURC (49.6%).",
    );
    expect(logged!.detail).toContain("Target: 50% USDC / 50% EURC.");
  });

  it("tells the operator what the rebalance cost in gas, beside what it filled", async () => {
    const id = await seedProposal({ executionTxHash: null });
    settleRebalance.mockResolvedValue(settled());

    await settleApprovedProposal(treasuryId, await proposal(id), null);

    const [logged] = await activities();
    // Arc bills gas in USDC out of the treasury, and the fill is reported
    // gross of it, so the cost is only visible if it is stated.
    expect(logged!.detail).toContain(
      "Arc gas for this rebalance cost 0.005696 USDC, taken from the treasury's own balance.",
    );
  });

  it("says the gas cost is not known rather than reporting the trade as free", async () => {
    const id = await seedProposal({ executionTxHash: null });
    settleRebalance.mockResolvedValue(settled({ gasCostUsdc: null }));

    await settleApprovedProposal(treasuryId, await proposal(id), null);

    const [logged] = await activities();
    expect(logged!.detail).toContain("what it cost is not known");
    expect(logged!.detail).not.toContain("cost 0 USDC");
  });

  it("records the gas beside the fill in the settlement audit detail", async () => {
    const id = await seedProposal({ executionTxHash: null });
    settleRebalance.mockResolvedValue(settled());

    startProposalSettlement(treasuryId, await proposal(id), null);
    await drainProposalSettlements();

    const [event] = await db
      .select()
      .from(auditEventsTable)
      .where(eq(auditEventsTable.treasuryId, treasuryId));
    expect(event).toMatchObject({ action: "proposal.settle", result: "ok" });
    // Intent, outcome and cost together: comparing rebalances needs all three.
    expect(event!.detail).toMatchObject({
      expectedOutput: "425",
      realisedOutput: "424.15",
      gasCostUsdc: "0.005696",
    });
  });

  it("says the fill is unknown rather than quoting the quote back as the fill", async () => {
    const id = await seedProposal({ executionTxHash: null });
    settleRebalance.mockResolvedValue(
      settled({
        realisedOutput: null,
        realisedSlippagePct: null,
        holdingsAfter: [],
        realisedNote:
          "Holdings could not be re-read after the swap confirmed (RPC timeout), so what the treasury now holds is unknown rather than unchanged.",
      }),
    );

    await settleApprovedProposal(treasuryId, await proposal(id), null);

    const [logged] = await activities();
    // Executed, because the swap confirmed - but nothing pretends to know the fill.
    expect(logged).toMatchObject({ status: "executed" });
    expect(logged!.detail).not.toContain("received");
    expect(logged!.detail).toContain("unknown rather than unchanged");
    expect(await proposal(id)).toMatchObject({ status: "executed" });
  });

  it("discards the signed swap unsent when the proposal was resolved meanwhile", async () => {
    const id = await seedProposal({ executionTxHash: null });
    let mayBroadcast: boolean | null = null;

    settleRebalance.mockImplementation(async (_t, _targets, _quote, claim) => {
      // An emergency reject lands while the swap is being prepared.
      await db
        .update(treasuryProposalsTable)
        .set({ status: "rejected" })
        .where(eq(treasuryProposalsTable.id, id));
      mayBroadcast = await claim(TX_HASH, db);
      return {
        kind: "refused",
        reason: "The rebalance was no longer awaiting settlement, so nothing was sent.",
      };
    });

    await settleApprovedProposal(treasuryId, await proposal(id), null);

    expect(mayBroadcast).toBe(false);
    // The reject stands, and no hash was written against it: nothing was sent.
    expect(await proposal(id)).toMatchObject({ status: "rejected", executionTxHash: null });
  });

  it("holds an unreadable swap at approved for reconciliation, never back at pending", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH });
    settleRebalance.mockResolvedValue({
      kind: "uncertain",
      reason: "The swap was broadcast but its receipt could not be read.",
      txHash: TX_HASH,
    });

    const result = await settleApprovedProposal(treasuryId, await proposal(id), null);

    expect(result.kind).toBe("unsettled");
    expect(await proposal(id)).toMatchObject({ status: "approved", executionTxHash: TX_HASH });
  });
});

describe("reconciling proposals stranded at approved", () => {
  it("executes one whose swap confirmed, reading the receipt rather than re-sending", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH });
    getTransferRecoveryStatus.mockResolvedValue("success");

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);

    expect(await proposal(id)).toMatchObject({ status: "executed", executionTxHash: TX_HASH });
    expect(settleRebalance).not.toHaveBeenCalled();
    const logged = await activities();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ status: "executed", txHash: TX_HASH });
  });

  it("reports what a recovered swap returned, read from its receipt", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH });
    getTransferRecoveryStatus.mockResolvedValue("success");
    // The balance this swap was sized against is long gone, but the transfer
    // that paid it out is still in the receipt.
    readFillFromReceipt.mockResolvedValue({
      token: { symbol: "EURC", decimals: 6 },
      credited: 424_400_000n,
    });
    readSettledOutcome.mockResolvedValue({
      realisedOutput: "424.4",
      realisedSlippagePct: null,
      holdingsAfter: [
        { symbol: "USDC", units: "499.98992", percentage: 50.4 },
        { symbol: "EURC", units: "424.4", percentage: 49.6 },
      ],
    });

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);

    expect(readFillFromReceipt).toHaveBeenCalledWith(treasuryId, TX_HASH);
    expect(readSettledOutcome).toHaveBeenCalledWith(
      treasuryId,
      expect.anything(),
      expect.objectContaining({ credited: 424_400_000n }),
    );
    const [logged] = await activities();
    expect(logged!.detail).toContain("The swap returned 424.4 EURC, read from its transfer logs.");
    expect(logged!.detail).toContain("The treasury now holds");
  });

  it("states where the book landed when it recovers a settled swap", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH });
    getTransferRecoveryStatus.mockResolvedValue("success");
    // The fill itself is unrecoverable this late - the balance it started from
    // is gone - but what the treasury holds now is still readable.
    readSettledOutcome.mockResolvedValue({
      realisedOutput: null,
      realisedSlippagePct: null,
      holdingsAfter: [
        { symbol: "USDC", units: "499.98992", percentage: 50.4 },
        { symbol: "EURC", units: "424.15", percentage: 49.6 },
      ],
    });

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);

    expect(await proposal(id)).toMatchObject({ status: "executed" });
    const [logged] = await activities();
    expect(logged!.detail).toContain(
      "The treasury now holds 499.98992 USDC (50.4%) and 424.15 EURC (49.6%).",
    );
  });

  it("hands a reverted swap back to the operator", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH });
    getTransferRecoveryStatus.mockResolvedValue("reverted");

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);

    expect(await proposal(id)).toMatchObject({ status: "pending", decidedAt: null });
    expect(settleRebalance).not.toHaveBeenCalled();
  });

  it("leaves a swap that is still confirming alone", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH, decidedAt: new Date() });
    getTransferRecoveryStatus.mockResolvedValue("pending");

    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);

    expect(await proposal(id)).toMatchObject({ status: "approved" });
    // Inside the grace window it is not even probed: a live settlement owns it.
    expect(getTransferRecoveryStatus).not.toHaveBeenCalled();
  });

  it("recovers a claim that never got as far as broadcasting", async () => {
    const id = await seedProposal({ executionTxHash: null });

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);

    // No hash means no swap was ever sent, so the operator can act again.
    expect(await proposal(id)).toMatchObject({ status: "pending", decidedAt: null });
    expect(getTransferRecoveryStatus).not.toHaveBeenCalled();
    const logged = await activities();
    expect(logged).toHaveLength(1);
    expect(logged[0]!.detail).toContain("no holdings moved");
  });

  it("leaves a fresh claim alone while its settlement is still working", async () => {
    const id = await seedProposal({ executionTxHash: null, decidedAt: new Date() });

    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);

    expect(await proposal(id)).toMatchObject({ status: "approved" });
  });

  it("resolves once when several instances reconcile the same proposal at once", async () => {
    const id = await seedProposal({ executionTxHash: TX_HASH });
    getTransferRecoveryStatus.mockResolvedValue("success");

    const runs = await Promise.all([
      reconcileApprovedProposals(treasuryId),
      reconcileApprovedProposals(treasuryId),
      reconcileApprovedProposals(treasuryId),
    ]);

    // One resolution, one activity row, whatever the fan-out.
    expect(runs.reduce((total, resolved) => total + resolved, 0)).toBe(1);
    expect(await proposal(id)).toMatchObject({ status: "executed" });
    expect(await activities()).toHaveLength(1);
    // A second pass over an already-terminal proposal is a no-op.
    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);
  });

  it("escalates a vanished transaction once instead of guessing at its outcome", async () => {
    const id = await seedProposal({
      executionTxHash: TX_HASH,
      decidedAt: new Date(Date.now() - 60 * 60_000),
    });
    getTransferRecoveryStatus.mockResolvedValue("missing");

    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);
    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);

    // Held at approved: re-sending is not an option, and calling it failed
    // would report an unwound trade whose swap could still be in a mempool.
    expect(await proposal(id)).toMatchObject({ status: "approved" });
    const raised = await alerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: "critical", kind: "rebalance.manual-review" });
    expect(raised[0]!.data).toMatchObject({ proposalId: id });
  });
});

const { ARC_TOKENS } = await import("./arc-tokens");

describe("carrying a target that needs more than one leg", () => {
  const ROTATION = [
    { symbol: "USDC", percentage: 60 },
    { symbol: "EURC", percentage: 10 },
    { symbol: "WETH", percentage: 30 },
  ];
  const buyWeth = {
    kind: "swap",
    leg: { input: ARC_TOKENS.USDC, output: ARC_TOKENS.WETH, amount: "232", amountBaseUnits: 232_000_000n, notionalUsd: 232 },
    outputHeldBefore: 0n,
  };
  const soldEurc = () =>
    settled({ inputSymbol: "EURC", outputSymbol: "USDC", amountIn: "200", expectedOutput: "232", minOutput: "231.3" });

  async function proposals() {
    return db.select().from(treasuryProposalsTable).where(eq(treasuryProposalsTable.treasuryId, treasuryId));
  }
  async function setMode(mode: string) {
    await db.insert(treasurySettingsTable).values({ id: treasuryId, mode });
  }
  async function activePolicy(): Promise<string> {
    const id = `policy-${randomUUID()}`;
    await db.insert(policiesTable).values({
      id,
      treasuryId,
      name: "Balanced",
      summary: "test",
      sourceCommand: "test",
      rules: {} as never,
      status: "active",
    });
    return id;
  }

  it("says the target is not yet reached after a sale, and drafts the purchase for approval", async () => {
    // Sell EURC first, then buy WETH with the USDC it freed: two swaps, two
    // proposals. The first must not read as the whole rotation done.
    const policyId = await activePolicy();
    const first = await seedProposal({ targetAllocations: ROTATION, action: "60/10/30", policyId });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue(buyWeth);

    await settleApprovedProposal(treasuryId, await proposal(first), null);

    expect(await proposal(first)).toMatchObject({ status: "executed", executionTxHash: TX_HASH });
    const [logged] = await activities();
    expect(logged!.detail).toContain(
      "This leg alone does not reach the approved target: about $232.00 of USDC still needs to move into WETH.",
    );
    expect(logged!.detail).toContain("waits for operator approval");
    const followUp = (await proposals()).find((p) => p.id !== first);
    expect(followUp).toMatchObject({
      status: "pending",
      policyId,
      targetAllocations: ROTATION,
      action: "60/10/30",
      title: 'Rebalance to "Balanced" targets (next leg)',
      executionTxHash: null,
    });
    expect(followUp!.summary).toContain("about $232.00 of USDC still needs to move into WETH");

    // The operator approves the second leg; once it settles the target is met
    // and the chain stops there.
    await db.update(treasuryProposalsTable).set({ status: "approved", decidedAt: new Date() }).where(eq(treasuryProposalsTable.id, followUp!.id));
    settleRebalance.mockResolvedValue(settled({ inputSymbol: "USDC", outputSymbol: "WETH", amountIn: "232", expectedOutput: "0.058", minOutput: "0.0578" }));
    planRebalanceLeg.mockResolvedValue({ kind: "nothing-to-do", reason: "on target" });
    await settleApprovedProposal(treasuryId, await proposal(followUp!.id), null);

    expect(await proposal(followUp!.id)).toMatchObject({ status: "executed" });
    expect((await activities()).at(-1)!.detail).toContain("The approved target is now reached, so no further leg is needed.");
    expect(await proposals()).toHaveLength(2);
    expect(settleRebalance).toHaveBeenCalledTimes(2);
  });

  it("does not draft anything when the leg reached the target", async () => {
    const id = await seedProposal();
    settleRebalance.mockResolvedValue(settled());
    await settleApprovedProposal(treasuryId, await proposal(id), null);
    expect(await proposals()).toHaveLength(1);
    expect((await activities())[0]!.detail).toContain("The approved target is now reached");
  });

  it("auto-approves and settles the next leg in Autonomous mode, under the same gates", async () => {
    await setMode("autonomous");
    // Auto-approval runs the same target validation a human approval does,
    // which reads the treasury's state row.
    await db.insert(treasuryStateTable).values({ id: treasuryId, usdcUnits: 0, lastUsdcPrice: 1 });
    const first = await seedProposal({ targetAllocations: ROTATION, executionTxHash: null });
    settleRebalance.mockResolvedValueOnce(soldEurc()).mockResolvedValueOnce(
      settled({ inputSymbol: "USDC", outputSymbol: "WETH", amountIn: "232", expectedOutput: "0.058", minOutput: "0.0578" }),
    );
    planRebalanceLeg
      .mockResolvedValueOnce(buyWeth)
      .mockResolvedValueOnce({ kind: "nothing-to-do", reason: "on target" });

    await settleApprovedProposal(treasuryId, await proposal(first), null);
    await drainProposalSettlements();

    const all = await proposals();
    expect(all).toHaveLength(2);
    const followUp = all.find((p) => p.id !== first)!;
    expect(followUp).toMatchObject({ status: "executed", executionTxHash: TX_HASH });
    expect(followUp.summary).toContain("Auto-approved under Autonomous mode");
    expect(settleRebalance).toHaveBeenCalledTimes(2);
    const logs = await activities();
    expect(logs[0]!.detail).toContain("auto-approved under Autonomous mode; it is settling now");
    expect(logs.at(-1)!.detail).toContain("The approved target is now reached");
  });

  it("holds a follow-up that would sell a holding to zero, even in Autonomous mode", async () => {
    await setMode("autonomous");
    const targets = [
      { symbol: "USDC", percentage: 70 },
      { symbol: "WETH", percentage: 30 },
    ];
    const first = await seedProposal({ targetAllocations: targets });
    settleRebalance.mockResolvedValue(settled({ inputSymbol: "USDC", outputSymbol: "WETH" }));
    planRebalanceLeg.mockResolvedValue({
      kind: "swap",
      leg: { input: ARC_TOKENS.cirBTC, output: ARC_TOKENS.USDC, amount: "0.001", amountBaseUnits: 100_000n, notionalUsd: 100 },
      outputHeldBefore: 0n,
    });

    await settleApprovedProposal(treasuryId, await proposal(first), null);
    await drainProposalSettlements();

    const followUp = (await proposals()).find((p) => p.id !== first)!;
    expect(followUp.status).toBe("pending");
    expect(followUp.summary).toContain("sells cirBTC down to zero");
    expect(settleRebalance).toHaveBeenCalledTimes(1);
  });

  it("holds the follow-up for an operator when the emergency pause is on", async () => {
    await setMode("autonomous");
    const { getSecurityControls } = await import("./security-controls");
    await getSecurityControls(treasuryId);
    await db.update(securityControlsTable).set({ pauseActive: true }).where(eq(securityControlsTable.id, treasuryId));
    const first = await seedProposal({ targetAllocations: ROTATION });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue(buyWeth);

    await settleApprovedProposal(treasuryId, await proposal(first), null);
    await drainProposalSettlements();

    const followUp = (await proposals()).find((p) => p.id !== first)!;
    expect(followUp.status).toBe("pending");
    expect(followUp.summary).toContain("the emergency pause is active");
    expect(settleRebalance).toHaveBeenCalledTimes(1);
  });

  it("stops chaining unattended once the hourly leg limit is reached", async () => {
    await setMode("autonomous");
    for (let i = 0; i < 12; i += 1) {
      await seedProposal({ status: "executed", executionTxHash: `0x${String(i).padStart(64, "0")}`, decidedAt: new Date() });
    }
    const first = await seedProposal({ targetAllocations: ROTATION });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue(buyWeth);

    await settleApprovedProposal(treasuryId, await proposal(first), null);
    await drainProposalSettlements();

    const followUp = (await proposals()).find((p) => p.status === "pending")!;
    expect(followUp).toBeDefined();
    expect(followUp.summary).toContain("limit for unattended continuation");
    expect(settleRebalance).toHaveBeenCalledTimes(1);
  });

  it("drafts a held follow-up rather than dropping the chain when the re-plan fails", async () => {
    await setMode("autonomous");
    const first = await seedProposal({ targetAllocations: ROTATION });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue({ kind: "refused", reason: "Arc could not be read." });

    await settleApprovedProposal(treasuryId, await proposal(first), null);
    await drainProposalSettlements();

    const [logged] = await activities();
    expect(logged!.detail).toContain("could not be confirmed: Arc could not be read.");
    const followUp = (await proposals()).find((p) => p.id !== first)!;
    expect(followUp.status).toBe("pending");
    expect(followUp.summary).toContain("could not confirm whether the target is reached");
    expect(settleRebalance).toHaveBeenCalledTimes(1);
  });

  it("drafts nothing when a rebalance for the same policy is already open", async () => {
    const policyId = await activePolicy();
    await seedProposal({ status: "pending", policyId, decidedAt: null });
    const first = await seedProposal({ targetAllocations: ROTATION, policyId });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue(buyWeth);

    await settleApprovedProposal(treasuryId, await proposal(first), null);

    expect(await proposals()).toHaveLength(2);
    expect((await activities())[0]!.detail).toContain("already waiting or settling, so no second one was drafted");
  });

  it("drafts nothing for a policy that was superseded meanwhile", async () => {
    const policyId = await activePolicy();
    await db.update(policiesTable).set({ status: "superseded" }).where(eq(policiesTable.id, policyId));
    const first = await seedProposal({ targetAllocations: ROTATION, policyId });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue(buyWeth);

    await settleApprovedProposal(treasuryId, await proposal(first), null);

    expect(await proposals()).toHaveLength(1);
    expect((await activities())[0]!.detail).toContain("no longer active, so no follow-up was drafted");
  });

  it("writes where the target stands onto the card itself", async () => {
    const first = await seedProposal({ targetAllocations: ROTATION });
    settleRebalance.mockResolvedValue(soldEurc());
    planRebalanceLeg.mockResolvedValue(buyWeth);

    await settleApprovedProposal(treasuryId, await proposal(first), null);

    const done = await proposal(first);
    expect(done.status).toBe("executed");
    expect(done.summary).toContain("This leg alone does not reach the approved target: about $232.00 of USDC still needs to move into WETH.");
    expect(done.summary).toContain("waits for operator approval");
  });

  it("finishes a leg the process died on after the swap confirmed, drafting exactly one next leg", async () => {
    // The crash window: the swap confirmed and the row reached "settled",
    // then nothing else happened. Reconciliation must finish it, once.
    const id = await seedProposal({
      status: "settled",
      targetAllocations: ROTATION,
      executionTxHash: TX_HASH,
      decidedAt: new Date(Date.now() - 10 * 60_000),
    });
    planRebalanceLeg.mockResolvedValue(buyWeth);

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);
    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);

    expect(await proposal(id)).toMatchObject({ status: "executed", executionTxHash: TX_HASH });
    const children = (await proposals()).filter((p) => p.id !== id);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ status: "pending", targetAllocations: ROTATION });
    const logs = await activities();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.detail).toContain("the process ended before the approved target was re-planned, so reconciliation finished it.");
    expect(logs[0]!.detail).toContain("about $232.00 of USDC still needs to move into WETH");
    expect(settleRebalance).not.toHaveBeenCalled();
  });

  it("leaves a freshly settled leg to the settlement that is still finishing it", async () => {
    const id = await seedProposal({ status: "settled", targetAllocations: ROTATION, executionTxHash: TX_HASH, decidedAt: new Date() });
    planRebalanceLeg.mockResolvedValue(buyWeth);

    expect(await reconcileApprovedProposals(treasuryId)).toBe(0);

    expect(await proposal(id)).toMatchObject({ status: "settled" });
    expect(await proposals()).toHaveLength(1);
    expect(planRebalanceLeg).not.toHaveBeenCalled();
  });

  it("continues the target when the reconciler recovers a leg", async () => {
    const id = await seedProposal({
      targetAllocations: ROTATION,
      executionTxHash: TX_HASH,
      decidedAt: new Date(Date.now() - 10 * 60_000),
    });
    getTransferRecoveryStatus.mockResolvedValue("success");
    planRebalanceLeg.mockResolvedValue(buyWeth);

    expect(await reconcileApprovedProposals(treasuryId)).toBe(1);

    const followUp = (await proposals()).find((p) => p.id !== id)!;
    expect(followUp).toMatchObject({ status: "pending", targetAllocations: ROTATION });
    expect((await activities())[0]!.detail).toContain("about $232.00 of USDC still needs to move into WETH");
  });
});
