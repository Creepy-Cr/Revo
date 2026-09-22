/**
 * What the console header badge is allowed to say.
 *
 * The badge renders `status` straight off the dashboard response, and for a
 * long time that value was a string written once into treasury_state at
 * initialisation and never touched again. An operator who switched the
 * treasury into Safe mode still saw AUTO-EXECUTE: the badge claimed the agent
 * could trade unattended while every guard - approvals, policy activation, the
 * engine - was in fact reading treasury_settings.mode and refusing to act.
 *
 * These tests switch the mode through the real endpoint an operator uses and
 * demand the dashboard follow it, so the badge can only ever overstate the
 * agent's authority if someone reintroduces a stored copy of the mode.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentActivitiesTable,
  auditEventsTable,
  db,
  navSnapshotsTable,
  securityControlsTable,
  treasuriesTable,
  treasurySettingsTable,
  treasuryStateTable,
} from "@workspace/db";
import { ARC_CHAIN_NAME } from "../lib/arc-chain";
import { ARC_TOKENS, priceIdOf } from "../lib/arc-tokens";
import { quoteFor } from "../lib/market-fixtures";

const TEST_TREASURY_ID = `test-treasury-dashboard-${randomUUID()}`;
const OPERATOR_WALLET = "0x0000000000000000000000000000000000000004";
const WALLET = "0x00000000000000000000000000000000000aE917";

process.env.CUSTODY_MASTER_SECRET ??= "test-only-custody-master-secret";

// An admin with a session signed just now: the only operator who may reach
// every mode, including the step-up-protected autonomous one.
vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireOperator: vi.fn(() => (req: any, _res: any, next: () => void) => {
      req.operator = {
        wallet: OPERATOR_WALLET,
        role: "admin",
        treasuryId: TEST_TREASURY_ID,
        sessionId: "test-session",
        sessionCreatedAt: new Date(),
      };
      next();
    }),
  };
});

vi.mock("../lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/market")>();
  return {
    ...actual,
    getMarketQuote: vi.fn(async () =>
      quoteFor(
        { USDC: 1, EURC: 1.16, syrupUSDC: 1.1, cirBTC: 110_000, WETH: 4_000, wARS: 0.00066 },
        { change24hBySymbol: { EURC: 0 } },
      ),
    ),
  };
});

// The chain read is pinned so these tests are about the mode and nothing else.
vi.mock("../lib/holdings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/holdings")>();
  return {
    ...actual,
    readCustodyHoldings: vi.fn(async () => ({
      ok: true,
      walletAddress: WALLET,
      holdings: Object.values(ARC_TOKENS).map((token) => ({
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        role: token.role,
        tradable: token.tradable,
        ...(token.untradableReason ? { untradableReason: token.untradableReason } : {}),
        priceId: priceIdOf(token.price),
        units: token.symbol === "USDC" ? 500 : 0,
        raw: token.symbol === "USDC" ? (500n * 10n ** BigInt(token.decimals)).toString() : "0",
      })),
      readAt: new Date().toISOString(),
    })),
  };
});

const { default: app } = await import("../app");

let baseUrl: string;
let server: ReturnType<typeof app.listen> | undefined;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** The dashboard as the console receives it. */
async function dashboard(): Promise<{ status: string; mode: string; network: string }> {
  const res = await api("/treasury/dashboard");
  expect(res.status).toBe(200);
  return (await res.json()) as { status: string; mode: string; network: string };
}

/** The mode switch an operator makes from the console's mode control. */
async function switchMode(mode: "safe" | "managed" | "autonomous"): Promise<void> {
  const res = await api("/treasury/mode", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ mode });
}

/** What the mode control itself reports, for comparison with the badge. */
async function reportedMode(): Promise<string> {
  const res = await api("/treasury/mode");
  expect(res.status).toBe(200);
  return ((await res.json()) as { mode: string }).mode;
}

beforeAll(async () => {
  await db.insert(treasuriesTable).values({
    id: TEST_TREASURY_ID,
    name: "Dashboard status integration test",
    ownerWallet: OPERATOR_WALLET,
  });
  await db.insert(treasuryStateTable).values({
    id: TEST_TREASURY_ID,
    usdcUnits: 500,
    lastUsdcPrice: 1,
  });
  const listeningServer = app.listen(0);
  server = listeningServer;
  await new Promise<void>((resolve) => listeningServer.once("listening", resolve));
  const addr = listeningServer.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  const cleanup = async () => {
    await db.delete(agentActivitiesTable).where(eq(agentActivitiesTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, TEST_TREASURY_ID));
    await db.delete(navSnapshotsTable).where(eq(navSnapshotsTable.treasuryId, TEST_TREASURY_ID));
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
  const failure = results.find((r) => r.status === "rejected");
  if (failure && failure.status === "rejected") throw failure.reason;
});

describe("dashboard status follows the operating mode", () => {
  it("reads MANAGED before an operator has chosen a mode", async () => {
    // A treasury nobody has configured proposes and waits. The badge has to
    // say so rather than inherit whatever was written at initialisation.
    const initial = await dashboard();

    expect(initial.mode).toBe("managed");
    expect(initial.status).toBe("MANAGED");
  });

  it("says SAFE the moment the treasury is switched into Safe mode", async () => {
    await switchMode("safe");

    const safe = await dashboard();

    // The failure this pins: the header still badging AUTO-EXECUTE while the
    // agent is not allowed to take a single action.
    expect(safe.status).toBe("SAFE");
    expect(safe.status).not.toBe("AUTONOMOUS");
    expect(safe.mode).toBe("safe");
    // ...and the badge agrees with the control the operator just used.
    expect(await reportedMode()).toBe("safe");
  });

  it("follows every further switch, in both directions", async () => {
    for (const [mode, status] of [
      ["autonomous", "AUTONOMOUS"],
      ["managed", "MANAGED"],
      ["safe", "SAFE"],
      ["autonomous", "AUTONOMOUS"],
    ] as const) {
      await switchMode(mode);

      const current = await dashboard();

      expect(current.status).toBe(status);
      expect(current.mode).toBe(mode);
      expect(await reportedMode()).toBe(mode);
    }
  });

  it("names the chain from the chain config rather than a stored string", async () => {
    // The network used to be a second init-time constant sitting next to the
    // status. It is one Arc client and one chain name, so they cannot drift.
    expect((await dashboard()).network).toBe(ARC_CHAIN_NAME);
  });
});
