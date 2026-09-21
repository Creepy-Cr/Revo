/**
 * The dashboard's valuation gate.
 *
 * Composition is read live from Arc, so an unreachable RPC reads as an empty
 * wallet unless something stops it. An understated total is indistinguishable
 * from a drawdown: it would be written into NAV history, charted as a crash,
 * and escalated into a critical breach alert over a network blip. These tests
 * hold the gate in place by stubbing the chain at the viem boundary and
 * running the real dashboard against a real database, rather than waiting for
 * an outage to prove the point in production.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  agentActivitiesTable,
  db,
  navSnapshotsTable,
  treasuriesTable,
  treasurySettingsTable,
  treasuryStateTable,
} from "@workspace/db";
import { ARC_TOKENS } from "./arc-tokens";
import type { MarketQuote } from "./market";

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

const CUSTODY_WALLET = "0x00000000000000000000000000000000000aE915";

/** What the stubbed Arc node answers: an outage, or the balances it holds. */
let chain: { down: string | null; balances: Record<string, number> } = {
  down: null,
  balances: {},
};

const readContract = vi.fn(async (args: Record<string, unknown>) => {
  if (chain.down) throw new Error(chain.down);
  const address = String(args["address"]).toLowerCase();
  const token = Object.values(ARC_TOKENS).find((t) => t.address.toLowerCase() === address);
  if (!token) throw new Error(`unexpected balanceOf call for ${address}`);
  return BigInt(Math.round((chain.balances[token.symbol] ?? 0) * 10 ** token.decimals));
});

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: () => ({ readContract }) };
});

vi.mock("./arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arc-chain")>();
  return {
    ...actual,
    ensureTreasuryWallet: vi.fn(async (treasuryId: string) => ({
      id: treasuryId,
      address: CUSTODY_WALLET,
    })),
  };
});

const getMarketQuote = vi.fn<() => Promise<MarketQuote | null>>();

vi.mock("./market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./market")>();
  return { ...actual, getMarketQuote };
});

const { computeDashboard } = await import("./state");
const { resetHoldingsClient } = await import("./holdings");

/** Units credited by confirmed deposits - the ledger the fallback reads. */
const LEDGER_USDC = 1000;
/** Yesterday's healthy NAV; every day-change figure is measured against it. */
const REFERENCE_NAV = 800;

/** A complete CoinGecko poll: every pinned token has a reference price. */
function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    usdcUsd: 1,
    eurUsd: 1.16,
    fetchedAt: Date.now(),
    stale: false,
    ...overrides,
  };
}

const treasuryIds: string[] = [];
let treasuryId: string;

async function seedTreasury(): Promise<string> {
  const id = `test-valuation-${randomUUID()}`;
  treasuryIds.push(id);
  await db.insert(treasuriesTable).values({
    id,
    name: "Valuation gate test",
    ownerWallet: `0x${randomUUID().replace(/-/g, "")}`,
  });
  await db.insert(treasuryStateTable).values({
    id,
    usdcUnits: LEDGER_USDC,
    lastUsdcPrice: 1,
  });
  await db.insert(navSnapshotsTable).values({
    id: `nav-${id}-reference`,
    treasuryId: id,
    time: new Date(Date.now() - 12 * 60 * 60_000),
    value: REFERENCE_NAV,
  });
  return id;
}

/** Every NAV value on record for a treasury, oldest first. */
async function navHistory(id: string): Promise<number[]> {
  const rows = await db
    .select({ value: navSnapshotsTable.value })
    .from(navSnapshotsTable)
    .where(eq(navSnapshotsTable.treasuryId, id))
    .orderBy(asc(navSnapshotsTable.time));
  return rows.map((row) => row.value);
}

beforeEach(async () => {
  readContract.mockClear();
  resetHoldingsClient();
  getMarketQuote.mockResolvedValue(quote());
  chain = { down: null, balances: { USDC: LEDGER_USDC } };
  treasuryId = await seedTreasury();
});

afterAll(async () => {
  for (const id of treasuryIds) {
    await db.delete(navSnapshotsTable).where(eq(navSnapshotsTable.treasuryId, id));
    await db.delete(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, id));
    // computeDashboard reads the operating mode, which materialises a settings
    // row on first read.
    await db.delete(treasurySettingsTable).where(eq(treasurySettingsTable.id, id));
    await db.delete(treasuryStateTable).where(eq(treasuryStateTable.id, id));
    await db.delete(treasuriesTable).where(eq(treasuriesTable.id, id));
  }
});

describe("computeDashboard valuation gate", () => {
  it("reports an unreachable Arc as incomplete and falls back to the deposit ledger", async () => {
    chain = { down: "arc rpc unreachable: connect ETIMEDOUT", balances: {} };

    const dashboard = await computeDashboard(treasuryId);

    expect(dashboard.valuation.complete).toBe(false);
    expect(dashboard.valuation.note).toMatch(/Arc could not be read/i);
    // The operator is told which failure this is, not left to guess.
    expect(dashboard.valuation.note).toContain("ETIMEDOUT");
    // The deposit ledger, never zero: an empty read is a drawdown to
    // everything downstream of this number.
    expect(dashboard.totalValue).toBe(LEDGER_USDC);
    expect(dashboard.allocations).toEqual([
      expect.objectContaining({
        symbol: "USDC",
        source: "accounting",
        units: LEDGER_USDC,
        value: LEDGER_USDC,
      }),
    ]);
    // Nothing about the outage enters NAV history...
    expect(await navHistory(treasuryId)).toEqual([REFERENCE_NAV]);
    expect(dashboard.portfolioHistory.map((point) => point.value)).toEqual([REFERENCE_NAV]);
    // ...and no day change is reported off it, though the same total on a
    // trusted read would chart as +25% against the reference.
    expect(dashboard.dayChange).toBe(0);
  });

  it("marks the valuation incomplete when a held asset has no reference price", async () => {
    chain = { down: null, balances: { USDC: LEDGER_USDC, EURC: 50 } };
    // CoinGecko omitted EURC on this poll, so part of the book is
    // unpriceable even though the chain read cleanly.
    getMarketQuote.mockResolvedValue(quote({ eurUsd: undefined }));

    const dashboard = await computeDashboard(treasuryId);

    expect(dashboard.valuation.complete).toBe(false);
    expect(dashboard.valuation.note).toContain("EURC");
    // The holding stays visible at its real size; only its value is unknown.
    expect(dashboard.allocations).toContainEqual(
      expect.objectContaining({ symbol: "EURC", units: 50, value: 0 }),
    );
    expect(await navHistory(treasuryId)).toEqual([REFERENCE_NAV]);
    expect(dashboard.dayChange).toBe(0);
  });

  it("snapshots and charts the day change when the ledger and the chain agree", async () => {
    chain = { down: null, balances: { USDC: LEDGER_USDC } };

    const dashboard = await computeDashboard(treasuryId);

    expect(dashboard.valuation).toEqual({ complete: true });
    expect(dashboard.totalValue).toBe(LEDGER_USDC);
    expect(dashboard.allocations.find((row) => row.symbol === "USDC")).toMatchObject({
      source: "onchain",
      units: LEDGER_USDC,
      percentage: 100,
    });
    expect(await navHistory(treasuryId)).toEqual([REFERENCE_NAV, LEDGER_USDC]);
    expect(dashboard.dayChange).toBe(25);
  });

  it("shows a real ledger/chain divergence rather than absorbing it", async () => {
    // The ledger still credits 1000 but the wallet holds 600. That is a
    // genuine shortfall, and it must reach the dashboard as one - the
    // fallback exists for an unreadable chain, not for a chain that disagrees.
    chain = { down: null, balances: { USDC: 600 } };

    const dashboard = await computeDashboard(treasuryId);

    expect(dashboard.valuation.complete).toBe(true);
    expect(dashboard.totalValue).toBe(600);
    expect(dashboard.allocations.find((row) => row.symbol === "USDC")).toMatchObject({
      source: "onchain",
      units: 600,
    });
    expect(await navHistory(treasuryId)).toEqual([REFERENCE_NAV, 600]);
    expect(dashboard.dayChange).toBe(-25);
  });
});
