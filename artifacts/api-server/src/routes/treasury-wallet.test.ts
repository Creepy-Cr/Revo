/**
 * Integration tests for the on-chain wallet routes, run against the real
 * database with the chain boundary (../lib/arc-chain) mocked.
 *
 * Focus: the funds-safety rules that a refactor could silently break -
 * concurrent withdrawals must be serialized by the custody lock, ledger
 * balances must stay exact, replayed authorizations must be rejected, and
 * nobody may withdraw more than they deposited.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import {
  auditEventsTable,
  alertsTable,
  db,
  onchainTransfersTable,
  securityControlsTable,
  treasuriesTable,
  treasuryStateTable,
} from "@workspace/db";

const TREASURY_ADDRESS = "0x00000000000000000000000000000000000aE915";
const TEST_TREASURY_ID = `test-treasury-wallet-${randomUUID()}`;
const INITIAL_USDC_UNITS = 100;
process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

// Tracks that sign→broadcast sequences never interleave (nonce safety).
let activeCustodyOps = 0;
let maxConcurrentCustodyOps = 0;

function randomHash(): Hex {
  const bytes = Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return `0x${bytes}` as Hex;
}

/** txHash → deposit verification result, controlling the verifyDeposit mock. */
const depositFixtures = new Map<string, { from: string; microUsdc: bigint }>();
const recoveryFixtures = new Map<string, "success" | "reverted" | "pending" | "missing" | "unknown">();
const broadcastPayloads: Array<{ hash: Hex; serialized: Hex }> = [];

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireOperator: vi.fn(() => (req: any, _res: any, next: () => void) => {
      req.operator = {
        wallet: "0x0000000000000000000000000000000000000001",
        role: "admin",
        treasuryId: TEST_TREASURY_ID,
        sessionId: "test-session",
        sessionCreatedAt: new Date(),
      };
      next();
    }),
  };
});

vi.mock("../lib/arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/arc-chain")>();
  return {
    ...actual,
    ensureTreasuryWallet: vi.fn(async (_treasuryId: string) => ({
      address: TREASURY_ADDRESS,
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    })),
    verifyDeposit: vi.fn(async (txHash: string) => {
      const fixture = depositFixtures.get(txHash.toLowerCase());
      if (!fixture) {
        throw new actual.ChainError("TX_NOT_FOUND", "test: unknown transaction");
      }
      return fixture;
    }),
    signUsdcTransfer: vi.fn(async () => {
      activeCustodyOps += 1;
      maxConcurrentCustodyOps = Math.max(maxConcurrentCustodyOps, activeCustodyOps);
      // Long enough that unserialized concurrent requests WOULD overlap.
      await new Promise((resolve) => setTimeout(resolve, 80));
      activeCustodyOps -= 1;
      return { hash: randomHash(), serialized: "0x00" as Hex, nonce: 7 };
    }),
    broadcastSignedTransfer: vi.fn(async (signed: { hash: Hex; serialized: Hex }) => {
      broadcastPayloads.push({ hash: signed.hash, serialized: signed.serialized });
      activeCustodyOps += 1;
      maxConcurrentCustodyOps = Math.max(maxConcurrentCustodyOps, activeCustodyOps);
      await new Promise((resolve) => setTimeout(resolve, 40));
      activeCustodyOps -= 1;
    }),
    confirmTransfer: vi.fn(async () => {}),
    getTransferReceiptStatus: vi.fn(async () => "unknown" as const),
    getTransferRecoveryStatus: vi.fn(async (hash: string) =>
      recoveryFixtures.get(hash) ?? "unknown" as const,
    ),
  };
});

// Keep the activity feed clean - tests must not surface fake entries in the UI.
vi.mock("../lib/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/state")>();
  return { ...actual, logActivity: vi.fn(async () => {}) };
});

const { withdrawalAuthMessage } = await import("../lib/arc-chain");
const { default: app } = await import("../app");

const walletA = privateKeyToAccount(generatePrivateKey());
const walletB = privateKeyToAccount(generatePrivateKey());
const addressA = walletA.address.toLowerCase();
const addressB = walletB.address.toLowerCase();

let baseUrl: string;
let server: ReturnType<typeof app.listen> | undefined;
let setupComplete = false;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function signedWithdrawal(
  account: typeof walletA,
  amountUsdc: number,
): Promise<Record<string, unknown>> {
  const address = account.address.toLowerCase();
  const issuedAt = new Date().toISOString();
  const amount = amountUsdc.toString();
  const signature = await account.signMessage({
    message: withdrawalAuthMessage(address, amount, issuedAt),
  });
  return { address, amountUsdc, issuedAt, signature };
}

async function treasuryUnits(): Promise<number> {
  const [state] = await db
    .select()
    .from(treasuryStateTable)
    .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
  return state.usdcUnits;
}

beforeAll(async () => {
  await db.insert(treasuriesTable).values({
    id: TEST_TREASURY_ID,
    name: "Treasury wallet integration test",
    ownerWallet: addressA,
  });
  await db.insert(treasuryStateTable).values({
    id: TEST_TREASURY_ID,
    usdcUnits: INITIAL_USDC_UNITS,
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

afterAll(async () => {
  const cleanup = async () => {
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(alertsTable).where(eq(alertsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(onchainTransfersTable).where(eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(securityControlsTable).where(eq(securityControlsTable.id, TEST_TREASURY_ID));
    await db.delete(treasuryStateTable).where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, TEST_TREASURY_ID));
  };
  const results = await Promise.allSettled([
    cleanup(),
    server
      ? new Promise<void>((resolve, reject) =>
          server!.close((err) => (err ? reject(err) : resolve())),
        )
      : Promise.resolve(),
  ]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  // When setup itself failed, preserve that original diagnostic rather than
  // replacing it with a secondary cleanup/server-close error.
  if (setupComplete && failure) throw failure.reason;
});

describe("deposit crediting", () => {
  it("credits a verified deposit exactly once (replay → 409)", async () => {
    const txHash = randomHash();
    depositFixtures.set(txHash, { from: addressA, microUsdc: 10_000_000n });

    const first = await api("/treasury/wallet/deposits", {
      method: "POST",
      body: JSON.stringify({ txHash }),
    });
    expect(first.status).toBe(201);
    const body = (await first.json()) as { amountUsdc: number; status: string };
    expect(body.amountUsdc).toBe(10);
    expect(body.status).toBe("confirmed");

    const replay = await api("/treasury/wallet/deposits", {
      method: "POST",
      body: JSON.stringify({ txHash }),
    });
    expect(replay.status).toBe(409);

    const txHashB = randomHash();
    depositFixtures.set(txHashB, { from: addressB, microUsdc: 7_000_000n });
    const second = await api("/treasury/wallet/deposits", {
      method: "POST",
      body: JSON.stringify({ txHash: txHashB }),
    });
    expect(second.status).toBe(201);

    expect(await treasuryUnits()).toBeCloseTo(INITIAL_USDC_UNITS + 17, 6);
  });
});

describe("concurrent withdrawals", () => {
  it("serializes custody signing/broadcast and keeps ledger balances exact", async () => {
    maxConcurrentCustodyOps = 0;

    const [bodyA, bodyB] = await Promise.all([
      signedWithdrawal(walletA, 4),
      signedWithdrawal(walletB, 7),
    ]);
    const [resA, resB] = await Promise.all([
      api("/treasury/wallet/withdrawals", { method: "POST", body: JSON.stringify(bodyA) }),
      api("/treasury/wallet/withdrawals", { method: "POST", body: JSON.stringify(bodyB) }),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([201, 409]);
    const successfulResponse = resA.status === 201 ? resA : resB;
    const successfulAmount = resA.status === 201 ? 4 : 7;
    const output = (await successfulResponse.json()) as { status: string };
    expect(output.status).toBe("confirmed");

    // The nonce-safety property: sign→broadcast sequences never interleave.
    expect(maxConcurrentCustodyOps).toBe(1);

    expect(await treasuryUnits()).toBeCloseTo(
      INITIAL_USDC_UNITS + 17 - successfulAmount,
      6,
    );
  });

  it("rejects a replayed authorization signature without touching balances", async () => {
    const body = await signedWithdrawal(walletA, 1);
    const unitsBefore = await treasuryUnits();

    const first = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const replay = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(replay.status).toBe(409);
    expect((await replay.json()) as object).toMatchObject({
      error: expect.stringContaining("already used"),
    });

    expect(await treasuryUnits()).toBeCloseTo(unitsBefore - 1, 6);
  });

  it("caps withdrawals at the wallet's net deposits", async () => {
    const body = await signedWithdrawal(walletB, 100);
    const res = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(409);

    // No pending/failed residue may have debited anything.
    const rows = await db
      .select()
      .from(onchainTransfersTable)
      .where(
        and(
          eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
          eq(onchainTransfersTable.wallet, addressB),
          eq(onchainTransfersTable.direction, "withdrawal"),
        ),
      );
    expect(rows.filter((r) => r.status !== "confirmed")).toHaveLength(0);
  });

  it("refunds the reservation when the node definitively rejects the broadcast", async () => {
    const { broadcastSignedTransfer, ChainError } = await import("../lib/arc-chain");
    const unitsBefore = await treasuryUnits();
    const posBefore = (await (await api(`/treasury/wallet/${addressA}/position`)).json()) as {
      netDepositedUsdc: number;
    };

    vi.mocked(broadcastSignedTransfer).mockRejectedValueOnce(
      new ChainError("SEND_FAILED", "test: node rejected the transaction"),
    );

    const body = await signedWithdrawal(walletA, 1);
    const res = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(502);

    // Refund restored both the treasury units and the wallet's balance.
    expect(await treasuryUnits()).toBeCloseTo(unitsBefore, 6);
    const posAfter = (await (await api(`/treasury/wallet/${addressA}/position`)).json()) as {
      netDepositedUsdc: number;
      transfers: Array<{ status: string; direction: string }>;
    };
    expect(posAfter.netDepositedUsdc).toBeCloseTo(posBefore.netDepositedUsdc, 6);
    expect(posAfter.transfers.filter((t) => t.status === "pending")).toHaveLength(0);
  });

  it("refunds a stale pending row with no tx hash (crash before broadcast) but leaves fresh ones alone", async () => {
    // Simulate a process crash after the reservation debited units but
    // before the signed hash was persisted: pending row, null txHash.
    const unitsBefore = await treasuryUnits();
    const staleId = `xfer-test-stale-${Date.now()}`;
    const freshId = `xfer-test-fresh-${Date.now()}`;
    await db.insert(onchainTransfersTable).values([
      {
        id: staleId,
        treasuryId: TEST_TREASURY_ID,
        direction: "withdrawal",
        wallet: addressA,
        amountUsdc: 2,
        status: "pending",
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
      {
        id: freshId,
        treasuryId: TEST_TREASURY_ID,
        direction: "withdrawal",
        wallet: addressA,
        amountUsdc: 1,
        status: "pending",
        createdAt: new Date(),
      },
    ]);
    // Mimic the reservation debit the crashed requests would have made.
    await db
      .update(treasuryStateTable)
      .set({ usdcUnits: unitsBefore - 3 })
      .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));

    // Position load triggers reconciliation.
    await api(`/treasury/wallet/${addressA}/position`);

    const rows = await db
      .select()
      .from(onchainTransfersTable)
      .where(
        and(
          eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
          inArray(onchainTransfersTable.id, [staleId, freshId]),
        ),
      );
    const stale = rows.find((r) => r.id === staleId);
    const fresh = rows.find((r) => r.id === freshId);
    expect(stale?.status).toBe("failed");
    expect(fresh?.status).toBe("pending");

    // Only the provably-unbroadcast stale row was refunded.
    expect(await treasuryUnits()).toBeCloseTo(unitsBefore - 1, 6);

    // Cleanup the simulated fresh row and its simulated debit.
    await db
      .delete(onchainTransfersTable)
      .where(
        and(
          eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
          eq(onchainTransfersTable.id, freshId),
        ),
      );
    await db
      .update(treasuryStateTable)
      .set({ usdcUnits: unitsBefore })
      .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
  });

  it("rebroadcasts the exact signed payload after a confirmation timeout and confirms it later", async () => {
    const { confirmTransfer, ChainError } = await import("../lib/arc-chain");
    vi.mocked(confirmTransfer).mockRejectedValueOnce(
      new ChainError("RPC_UNAVAILABLE", "test upstream detail must remain server-side"),
    );
    const broadcastsBefore = broadcastPayloads.length;
    const response = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(await signedWithdrawal(walletA, 0.5)),
    });
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("test upstream detail");

    const pendingRows = await db
      .select()
      .from(onchainTransfersTable)
      .where(
        and(
          eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
          eq(onchainTransfersTable.wallet, addressA),
          eq(onchainTransfersTable.status, "pending"),
        ),
      );
    const pending = pendingRows.at(-1)!;
    expect(pending.signedPayload).toBeTruthy();
    expect(pending.signedPayload).not.toContain("0x00");
    await db
      .update(onchainTransfersTable)
      .set({
        createdAt: new Date(Date.now() - 60_000),
        lastBroadcastAt: new Date(Date.now() - 60_000),
      })
      .where(eq(onchainTransfersTable.id, pending.id));
    recoveryFixtures.set(pending.txHash!, "missing");

    await api(`/treasury/wallet/${addressA}/position`);
    const attempts = broadcastPayloads.slice(broadcastsBefore);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);

    recoveryFixtures.set(pending.txHash!, "success");
    await api(`/treasury/wallet/${addressA}/position`);
    const [confirmed] = await db
      .select()
      .from(onchainTransfersTable)
      .where(eq(onchainTransfersTable.id, pending.id));
    expect(confirmed.status).toBe("confirmed");
  });

  it("recovers a crash after signed-payload persistence using an identical broadcast", async () => {
    const { sealRecoveryPayload } = await import("../lib/custody-crypto");
    const hash = randomHash();
    const serialized = "0x1234" as Hex;
    const id = `xfer-crash-signed-${randomUUID()}`;
    const unitsBefore = await treasuryUnits();
    await db.insert(onchainTransfersTable).values({
      id,
      treasuryId: TEST_TREASURY_ID,
      direction: "withdrawal",
      wallet: addressA,
      amountUsdc: 0.25,
      txHash: hash,
      status: "pending",
      signedPayload: sealRecoveryPayload(serialized),
      txNonce: 9,
      broadcastAttempts: 1,
      lastBroadcastAt: new Date(Date.now() - 60_000),
      recoveryState: "retrying",
      createdAt: new Date(Date.now() - 60_000),
    });
    await db
      .update(treasuryStateTable)
      .set({ usdcUnits: unitsBefore - 0.25 })
      .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
    recoveryFixtures.set(hash, "missing");

    await api(`/treasury/wallet/${addressA}/position`);
    expect(broadcastPayloads.at(-1)).toEqual({ hash, serialized });

    recoveryFixtures.set(hash, "success");
    await api(`/treasury/wallet/${addressA}/position`);
    const [row] = await db
      .select()
      .from(onchainTransfersTable)
      .where(eq(onchainTransfersTable.id, id));
    expect(row.status).toBe("confirmed");
  });

  it("bounds identical rebroadcast attempts and enters durable manual review without refund", async () => {
    const { confirmTransfer, ChainError } = await import("../lib/arc-chain");
    vi.mocked(confirmTransfer).mockRejectedValueOnce(
      new ChainError("RPC_UNAVAILABLE", "test timeout"),
    );
    const unitsBefore = await treasuryUnits();
    const response = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(await signedWithdrawal(walletA, 0.25)),
    });
    expect(response.status).toBe(502);
    const [pending] = await db
      .select()
      .from(onchainTransfersTable)
      .where(
        and(
          eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
          eq(onchainTransfersTable.status, "pending"),
        ),
      );
    recoveryFixtures.set(pending.txHash!, "missing");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await db
        .update(onchainTransfersTable)
        .set({
          createdAt: new Date(Date.now() - 60_000),
          lastBroadcastAt: new Date(Date.now() - 60_000),
        })
        .where(eq(onchainTransfersTable.id, pending.id));
      await api(`/treasury/wallet/${addressA}/position`);
    }

    const [flagged] = await db
      .select()
      .from(onchainTransfersTable)
      .where(eq(onchainTransfersTable.id, pending.id));
    expect(flagged.status).toBe("pending");
    expect(flagged.broadcastAttempts).toBe(3);
    expect(flagged.recoveryState).toBe("manual_review");
    expect(await treasuryUnits()).toBeCloseTo(unitsBefore - 0.25, 6);
    const alerts = await db
      .select()
      .from(alertsTable)
      .where(
        and(
          eq(alertsTable.treasuryId, TEST_TREASURY_ID),
          eq(alertsTable.kind, "withdrawal.manual-review"),
        ),
      );
    expect(alerts).toHaveLength(1);
  });

  it("rejects tampered signatures (signed by a different wallet)", async () => {
    const issuedAt = new Date().toISOString();
    const signature = await walletB.signMessage({
      message: withdrawalAuthMessage(addressA, "1", issuedAt),
    });
    const res = await api("/treasury/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify({ address: addressA, amountUsdc: 1, issuedAt, signature }),
    });
    expect(res.status).toBe(401);
  });
});
