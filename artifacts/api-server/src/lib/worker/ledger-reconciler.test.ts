import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, treasuriesTable, treasuryStateTable, workerStateTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const readCustodyHoldings = vi.fn();
const getMarketQuote = vi.fn();
const raiseAlert = vi.fn();
const setEmergencyPause = vi.fn();

vi.mock("../holdings", () => ({ readCustodyHoldings }));
vi.mock("../alerts", () => ({ raiseAlert }));
vi.mock("../security-controls", () => ({ setEmergencyPause }));
vi.mock("../market", () => ({
  getMarketQuote,
  referencePriceFor: (id: string, quote: { usdcUsd: number; eurUsd?: number } | null) =>
    id === "coingecko:usd-coin" ? quote?.usdcUsd : id === "coingecko:euro-coin" ? quote?.eurUsd : undefined,
}));

const { processTreasury } = await import("./ledger-reconciler");
const treasuryIds: string[] = [];
let treasuryId: string;

function holdings(usdc: number, eurc = 0) {
  return {
    ok: true,
    walletAddress: "0x0000000000000000000000000000000000000001",
    readAt: new Date().toISOString(),
    holdings: [
      { symbol: "USDC", priceId: "coingecko:usd-coin", units: usdc },
      { symbol: "EURC", priceId: "coingecko:euro-coin", units: eurc },
    ],
  };
}

async function checkpoint() {
  const [row] = await db
    .select()
    .from(workerStateTable)
    .where(eq(workerStateTable.id, `ledger-reconciler:${treasuryId}`));
  return row?.checkpoint as { discrepancy?: string | null; checkedAt?: string } | undefined;
}

async function run() {
  return processTreasury(treasuryId, new AbortController().signal);
}

beforeEach(async () => {
  vi.clearAllMocks();
  treasuryId = `test-ledger-reconciler-${randomUUID()}`;
  treasuryIds.push(treasuryId);
  await db.insert(treasuriesTable).values({
    id: treasuryId,
    name: "Ledger reconciler test",
    ownerWallet: `0x${randomUUID().replace(/-/g, "")}`,
  });
  await db.execute(sql`
    INSERT INTO treasury_state (id, usdc_units, last_usdc_price)
    VALUES (${treasuryId}, 100, 1)
  `);
  getMarketQuote.mockResolvedValue({
    usdcUsd: 1, eurUsd: 1.1, fetchedAt: Date.now(), stale: false,
  });
  setEmergencyPause.mockResolvedValue({});
  raiseAlert.mockResolvedValue(undefined);
});

afterAll(async () => {
  for (const id of treasuryIds) {
    await db.delete(workerStateTable).where(eq(workerStateTable.id, `ledger-reconciler:${id}`));
    await db.delete(treasuryStateTable).where(eq(treasuryStateTable.id, id));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, id));
  }
});

describe("ledger reconciler", () => {
  it("pauses and alerts once for a repeated shortfall", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(90));
    await run();
    await run();

    expect(setEmergencyPause).toHaveBeenCalledOnce();
    expect(setEmergencyPause.mock.calls[0]![0]).toMatchObject({
      active: true,
      actorWallet: "system",
      actorRole: "system",
      reason: "Ledger reconciliation detected a 10.00 USDC shortfall (ledger 100.00 USDC, on-chain 90.00 USDC).",
    });
    expect(raiseAlert).toHaveBeenCalledOnce();
    expect(raiseAlert.mock.calls[0]![0]).toMatchObject({
      severity: "critical", kind: "ledger.chain-mismatch",
    });
  });

  it("warns only for an on-chain surplus", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(105));
    await run();

    expect(setEmergencyPause).not.toHaveBeenCalled();
    expect(raiseAlert).toHaveBeenCalledWith(expect.objectContaining({
      severity: "warning", kind: "ledger.chain-mismatch",
    }));
  });

  it("does nothing when the RPC read fails", async () => {
    readCustodyHoldings.mockResolvedValue({
      ok: false, walletAddress: null, holdings: [], error: "RPC down", readAt: new Date().toISOString(),
    });
    await run();

    expect(setEmergencyPause).not.toHaveBeenCalled();
    expect(raiseAlert).not.toHaveBeenCalled();
    expect(await checkpoint()).toBeUndefined();
  });

  it("writes a healthy checkpoint", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(99.5));
    await run();

    expect(await checkpoint()).toMatchObject({ discrepancy: null, checkedAt: expect.any(String) });
    expect(raiseAlert).not.toHaveBeenCalled();
  });
});