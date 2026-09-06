/**
 * Route-level tests for approving a rebalance, run against the real database
 * with the chain boundary (settleRebalance) stubbed.
 *
 * The settlement engine has unit tests of its own. What is pinned down here is
 * the wrapper the routes put around it, which is where the funds-safety rules
 * live: the claim taken inside a transaction under the transition lock, the
 * settlement deliberately run outside both, and the terminal status write that
 * only lands while the proposal is still the claim the settlement started
 * from. Between them those are the only thing standing between one approved
 * rebalance and two swaps.
 *
 * Every settlement outcome is chosen by the stub, so what is under test is the
 * route's decision rather than the network. The database is the real
 * development one, so the treasury id is unique per run and every row it owns
 * is deleted afterwards.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentActivitiesTable,
  alertsTable,
  auditEventsTable,
  db,
  navSnapshotsTable,
  policiesTable,
  securityControlsTable,
  treasuriesTable,
  treasuryProposalsTable,
  treasurySettingsTable,
  treasuryStateTable,
  type PolicyRules,
} from "@workspace/db";
import { ARC_TOKENS } from "../lib/arc-tokens";

const TEST_TREASURY_ID = `test-treasury-approve-${randomUUID()}`;
const WALLET = "0x00000000000000000000000000000000000Ae916";
const OPERATOR_WALLET = "0x0000000000000000000000000000000000000002";
/** Held balance behind every allocation percentage these tests reason about. */
const HELD_USDC = 1_000;
const TARGETS = [
  { symbol: "USDC", percentage: 60 },
  { symbol: "EURC", percentage: 40 },
];

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

/**
 * The chain boundary. Every swap any of these tests could send has to pass
 * through this stub, so its call count IS the number of trades attempted.
 */
const settleRebalance = vi.fn();

vi.mock("../lib/rebalance-execution", () => ({ settleRebalance }));

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireOperator: vi.fn(() => (req: any, _res: any, next: () => void) => {
      req.operator = {
        wallet: OPERATOR_WALLET,
        role: "approver",
        treasuryId: TEST_TREASURY_ID,
        sessionId: "test-session",
        sessionCreatedAt: new Date(),
      };
      next();
    }),
  };
});

// Market prices and custody balances are network reads. Pinning both keeps the
// engine's targets, and therefore the approval decisions, deterministic.
vi.mock("../lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/market")>();
  return {
    ...actual,
    getMarketQuote: vi.fn(async () => ({
      usdcUsd: 1,
      eurUsd: 1.16,
      eurChange24h: 0,
      btcUsd: 80_000,
      btcChange24h: 0,
      fetchedAt: Date.now(),
      stale: false,
    })),
  };
});

vi.mock("../lib/holdings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/holdings")>();
  return {
    ...actual,
    // Entirely liquid, so any policy carrying a euro sleeve drifts from it and
    // the engine has a rebalance to draft.
    readCustodyHoldings: vi.fn(async () => ({
      ok: true,
      walletAddress: WALLET,
      holdings: Object.values(ARC_TOKENS).map((token) => {
        const units = token.symbol === "USDC" ? HELD_USDC : 0;
        return {
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          decimals: token.decimals,
          role: token.role,
          tradable: token.tradable,
          ...(token.untradableReason ? { untradableReason: token.untradableReason } : {}),
          coingeckoId: token.coingeckoId,
          units,
          raw: (BigInt(units) * 10n ** BigInt(token.decimals)).toString(),
        };
      }),
      readAt: new Date().toISOString(),
    })),
  };
});

const { default: app } = await import("../app");
const { drainProposalSettlements } = await import("../lib/rebalance-settlement");

let baseUrl: string;
let server: ReturnType<typeof app.listen> | undefined;
let setupComplete = false;

/** Distinct per settlement so an activity row can be traced to one attempt. */
let hashCount = 0;
function nextHash(): string {
  hashCount += 1;
  return `0x${hashCount.toString(16).padStart(64, "0")}`;
}

interface Deferred {
  promise: Promise<void>;
  release: () => void;
}

/** Gates released in afterEach too, so a failed assertion cannot hang the run. */
const openGates: Deferred[] = [];

function gate(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deferred = { promise, release };
  openGates.push(deferred);
  return deferred;
}

function settledOutcome(txHash: string) {
  return {
    kind: "settled",
    settlement: {
      txHash,
      explorerUrl: `https://explorer/${txHash}`,
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amountIn: "400.000000",
      expectedOutput: "344.827586",
      minOutput: "343.103448",
      feeTier: 3000,
    },
  };
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function approve(proposalId: string): Promise<Response> {
  return api(`/treasury/proposals/${proposalId}/approve`, { method: "POST" });
}

async function reject(proposalId: string, reason: string): Promise<Response> {
  return api(`/treasury/proposals/${proposalId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

async function seedProposal(
  overrides: Partial<typeof treasuryProposalsTable.$inferInsert> = {},
): Promise<string> {
  const id = `prop-${randomUUID()}`;
  await db.insert(treasuryProposalsTable).values({
    id,
    treasuryId: TEST_TREASURY_ID,
    title: "Rotate into the euro sleeve",
    summary: "Move 40% of the book into EURC.",
    status: "pending",
    action: "60% USDC / 40% EURC",
    safetyChecks: ["Simulated against live balances"],
    command: "rebalance to 60/40",
    targetAllocations: TARGETS,
    ...overrides,
  });
  return id;
}

async function proposalRow(id: string) {
  const [row] = await db
    .select()
    .from(treasuryProposalsTable)
    .where(eq(treasuryProposalsTable.id, id));
  return row!;
}

async function proposalsForPolicy(policyId: string) {
  return db
    .select()
    .from(treasuryProposalsTable)
    .where(
      and(
        eq(treasuryProposalsTable.treasuryId, TEST_TREASURY_ID),
        eq(treasuryProposalsTable.policyId, policyId),
      ),
    );
}

/** Operator-facing activity rows naming one specific swap. */
async function activitiesForHash(txHash: string) {
  return db
    .select()
    .from(agentActivitiesTable)
    .where(
      and(
        eq(agentActivitiesTable.treasuryId, TEST_TREASURY_ID),
        eq(agentActivitiesTable.txHash, txHash),
      ),
    );
}

async function seedPolicyDraft(): Promise<string> {
  const id = `policy-${randomUUID()}`;
  await db.insert(policiesTable).values({
    id,
    treasuryId: TEST_TREASURY_ID,
    name: "Euro sleeve",
    summary: "Keep a small euro sleeve and the rest liquid.",
    sourceCommand: "keep about a tenth in euro exposure",
    rules: {
      maxAllocationPct: 30,
      stablecoinReserveMinPct: 40,
      drawdownLimitPct: 20,
      riskTolerance: "medium",
    } satisfies PolicyRules,
    status: "draft",
  });
  return id;
}

async function setMode(mode: "safe" | "managed" | "autonomous"): Promise<void> {
  await db
    .insert(treasurySettingsTable)
    .values({ id: TEST_TREASURY_ID, mode })
    .onConflictDoUpdate({ target: treasurySettingsTable.id, set: { mode } });
}

beforeAll(async () => {
  await db.insert(treasuriesTable).values({
    id: TEST_TREASURY_ID,
    name: "Proposal approval integration test",
    ownerWallet: OPERATOR_WALLET,
  });
  await db.insert(treasuryStateTable).values({
    id: TEST_TREASURY_ID,
    usdcUnits: HELD_USDC,
    lastUsdcPrice: 1,
    status: "Active",
    network: "Arc Testnet",
  });
  const listeningServer = app.listen(0);
  server = listeningServer;
  await new Promise<void>((resolve) => listeningServer.once("listening", resolve));
  const addr = listeningServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  setupComplete = true;
});

afterEach(async () => {
  // Nothing may still be settling when the next test installs its own stub.
  for (const open of openGates.splice(0)) open.release();
  await drainProposalSettlements();
  settleRebalance.mockReset();
});

afterAll(async () => {
  const cleanup = async () => {
    await db.delete(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(alertsTable).where(eq(alertsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(navSnapshotsTable).where(eq(navSnapshotsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(treasuryProposalsTable).where(eq(treasuryProposalsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(policiesTable).where(eq(policiesTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(treasurySettingsTable).where(eq(treasurySettingsTable.id, TEST_TREASURY_ID));
    await db.delete(securityControlsTable).where(eq(securityControlsTable.id, TEST_TREASURY_ID));
    await db.delete(treasuryStateTable).where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, TEST_TREASURY_ID));
  };
  const results = await Promise.allSettled([
    cleanup(),
    server
      ? new Promise<void>((resolve, thrown) =>
          server!.close((err) => (err ? thrown(err) : resolve())),
        )
      : Promise.resolve(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  // When setup itself failed, preserve that original diagnostic rather than
  // replacing it with a secondary cleanup/server-close error.
  if (setupComplete && failure) throw failure.reason;
});

describe("approving a proposal", () => {
  it("sends one swap when two operators approve the same rebalance at once", async () => {
    const id = await seedProposal();
    const txHash = nextHash();
    const settling = gate();
    settleRebalance.mockImplementation(async () => {
      await settling.promise;
      return settledOutcome(txHash);
    });

    const [first, second] = await Promise.all([approve(id), approve(id)]);

    // One claim wins; the other is told the rebalance is already being settled.
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(await loser.json()).toMatchObject({
      error: expect.stringContaining("already approved"),
    });
    expect(await proposalRow(id)).toMatchObject({ status: "approved" });
    expect(settleRebalance).toHaveBeenCalledTimes(1);

    settling.release();
    await drainProposalSettlements();

    expect(await proposalRow(id)).toMatchObject({ status: "executed", executionTxHash: txHash });
    // Still one trade, narrated to the operator exactly once.
    expect(settleRebalance).toHaveBeenCalledTimes(1);
    expect(await activitiesForHash(txHash)).toHaveLength(1);
  });

  it("does not overwrite a rejection that lands while the swap is settling", async () => {
    const id = await seedProposal();
    const txHash = nextHash();
    const rejected = gate();
    let claimedAtBroadcast: boolean | null = null;
    settleRebalance.mockImplementation(async (_treasuryId, _targets, _quote, claim) => {
      await rejected.promise;
      claimedAtBroadcast = await claim(txHash, db);
      // Worst case for the guard: the settlement believes its swap confirmed.
      return settledOutcome(txHash);
    });

    expect((await approve(id)).status).toBe(200);

    // The operator route will not reject a proposal that is already settling:
    // "approved" is not an actionable status.
    const viaRoute = await reject(id, "Changed my mind");
    expect(viaRoute.status).toBe(409);
    expect(await proposalRow(id)).toMatchObject({ status: "approved" });

    // An out-of-band emergency resolution lands instead - the case every
    // status write in the settlement path is guarded against.
    await db
      .update(treasuryProposalsTable)
      .set({ status: "rejected", decidedAt: new Date() })
      .where(eq(treasuryProposalsTable.id, id));
    rejected.release();
    await drainProposalSettlements();

    // The pre-broadcast claim is refused, so nothing would have been sent, and
    // the terminal write cannot turn the rejection into an execution.
    expect(claimedAtBroadcast).toBe(false);
    expect(await proposalRow(id)).toMatchObject({ status: "rejected", executionTxHash: null });
    expect(await activitiesForHash(txHash)).toHaveLength(0);
  });

  it("returns a refused settlement to the operator, who can approve it again", async () => {
    const id = await seedProposal();
    settleRebalance.mockResolvedValue({
      kind: "refused",
      reason: "Synthra could not price a tradable USDC to EURC swap, so nothing was signed.",
    });

    expect((await approve(id)).status).toBe(200);
    await drainProposalSettlements();

    // Nothing of the treasury's value moved, so the proposal is actionable.
    expect(await proposalRow(id)).toMatchObject({
      status: "pending",
      decidedAt: null,
      executionTxHash: null,
    });

    const txHash = nextHash();
    settleRebalance.mockResolvedValue(settledOutcome(txHash));
    expect((await approve(id)).status).toBe(200);
    await drainProposalSettlements();

    expect(await proposalRow(id)).toMatchObject({ status: "executed", executionTxHash: txHash });
    expect(settleRebalance).toHaveBeenCalledTimes(2);
  });

  it("keeps an unresolved swap claimed rather than offering it for a second approval", async () => {
    const id = await seedProposal();
    const txHash = nextHash();
    settleRebalance.mockImplementation(async (_treasuryId, _targets, _quote, claim) => {
      // The hash is durable before the broadcast, so the reconciler can read
      // this attempt's receipt.
      await claim(txHash, db);
      return {
        kind: "uncertain",
        reason: "The swap was broadcast but its receipt could not be read.",
        txHash,
      };
    });

    expect((await approve(id)).status).toBe(200);
    await drainProposalSettlements();

    // A signed swap may still land, so the proposal stays claimed.
    expect(await proposalRow(id)).toMatchObject({ status: "approved", executionTxHash: txHash });

    const second = await approve(id);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({
      error: expect.stringContaining("already approved"),
    });
    expect(settleRebalance).toHaveBeenCalledTimes(1);
  });
});

describe("approving a policy in autonomous mode", () => {
  beforeAll(async () => {
    await setMode("autonomous");
  });

  it("activates the policy even though its auto-approved rebalance refuses to settle", async () => {
    const policyId = await seedPolicyDraft();
    settleRebalance.mockResolvedValue({
      kind: "refused",
      reason: "Synthra could not price a tradable USDC to EURC swap, so nothing was signed.",
    });

    const response = await api(`/treasury/policies/${policyId}/approve`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: policyId, status: "active" });
    await drainProposalSettlements();

    const [policy] = await db.select().from(policiesTable).where(eq(policiesTable.id, policyId));
    expect(policy!.status).toBe("active");
    // The rules are live; only the trade failed, so the operator gets the
    // rebalance back rather than a policy stuck in draft.
    const [proposal] = await proposalsForPolicy(policyId);
    expect(proposal).toMatchObject({ status: "pending", decidedAt: null });
    expect(settleRebalance).toHaveBeenCalledTimes(1);
  });

  it("activates the policy even when the settlement throws outright", async () => {
    const policyId = await seedPolicyDraft();
    settleRebalance.mockRejectedValue(new Error("test: the settlement engine threw"));

    const response = await api(`/treasury/policies/${policyId}/approve`, { method: "POST" });

    expect(response.status).toBe(200);
    await drainProposalSettlements();

    const [policy] = await db.select().from(policiesTable).where(eq(policiesTable.id, policyId));
    expect(policy!.status).toBe("active");
    // Nothing was written over the claim, and no hash was recorded, so
    // reconciliation can hand it back without risking a second trade.
    const [proposal] = await proposalsForPolicy(policyId);
    expect(proposal).toMatchObject({ status: "approved", executionTxHash: null });
  });
});
