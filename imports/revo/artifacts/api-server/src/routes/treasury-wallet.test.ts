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
import { and, eq, inArray } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { db, onchainTransfersTable, treasuryStateTable } from "@workspace/db";

const TREASURY_ADDRESS = "0x00000000000000000000000000000000000aE915";
const TEST_TREASURY_ID = "main";

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
      return { hash: randomHash(), serialized: "0x00" as Hex };
    }),
    broadcastSignedTransfer: vi.fn(async () => {
      activeCustodyOps += 1;
      maxConcurrentCustodyOps = Math.max(maxConcurrentCustodyOps, activeCustodyOps);
      await new Promise((resolve) => setTimeout(resolve, 40));
      activeCustodyOps -= 1;
    }),
    confirmTransfer: vi.fn(async () => {}),
    getTransferReceiptStatus: vi.fn(async () => "unknown" as const),
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
let server: ReturnType<typeof app.listen>;
let initialUsdcUnits: number;

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
  initialUsdcUnits = await treasuryUnits();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  // Remove test ledger rows and restore the treasury units exactly.
  await db
    .delete(onchainTransfersTable)
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, TEST_TREASURY_ID),
        inArray(onchainTransfersTable.wallet, [addressA, addressB]),
      ),
    );
  await db
    .update(treasuryStateTable)
    .set({ usdcUnits: initialUsdcUnits, updatedAt: new Date() })
    .where(eq(treasuryStateTable.id, TEST_TREASURY_ID));
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
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

    expect(await treasuryUnits()).toBeCloseTo(initialUsdcUnits + 17, 6);
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

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const [outA, outB] = (await Promise.all([resA.json(), resB.json()])) as Array<{
      status: string;
    }>;
    expect(outA.status).toBe("confirmed");
    expect(outB.status).toBe("confirmed");

    // The nonce-safety property: sign→broadcast sequences never interleave.
    expect(maxConcurrentCustodyOps).toBe(1);

    // Ledger exactness: +10 +7 −4 −7 = +6 vs the initial reserve.
    expect(await treasuryUnits()).toBeCloseTo(initialUsdcUnits + 6, 6);

    const posA = (await (await api(`/treasury/wallet/${addressA}/position`)).json()) as {
      netDepositedUsdc: number;
    };
    const posB = (await (await api(`/treasury/wallet/${addressB}/position`)).json()) as {
      netDepositedUsdc: number;
    };
    expect(posA.netDepositedUsdc).toBeCloseTo(6, 6);
    expect(posB.netDepositedUsdc).toBeCloseTo(0, 6);
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
