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
  alertsTable,
  auditEventsTable,
  db,
  treasuriesTable,
  treasuryProposalsTable,
} from "@workspace/db";

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

const settleRebalance = vi.fn();
const getTransferRecoveryStatus = vi.fn();

vi.mock("./rebalance-execution", () => ({ settleRebalance }));

vi.mock("./arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arc-chain")>();
  return { ...actual, getTransferRecoveryStatus };
});

const { reconcileApprovedProposals, settleApprovedProposal } = await import(
  "./rebalance-settlement"
);

const TX_HASH = `0x${"ab".repeat(32)}`;
const TARGETS = [
  { symbol: "USDC", percentage: 50 },
  { symbol: "EURC", percentage: 50 },
];

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
  vi.clearAllMocks();
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
      return {
        kind: "settled",
        settlement: {
          txHash: TX_HASH,
          inputSymbol: "USDC",
          outputSymbol: "EURC",
          amountIn: "500.000000",
          expectedOutput: "425.000000",
          minOutput: "422.875000",
          feeTier: 3000,
          explorerUrl: `https://explorer/${TX_HASH}`,
        },
      };
    });

    const result = await settleApprovedProposal(treasuryId, await proposal(id), null);

    expect(hashAtBroadcastTime).toBe(TX_HASH);
    expect(result.kind).toBe("executed");
    expect(await proposal(id)).toMatchObject({ status: "executed", executionTxHash: TX_HASH });
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
