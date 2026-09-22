import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { quoteFor } from "../lib/market-fixtures";

const checkVenue = vi.fn();
const getSwapQuote = vi.fn();
const getMarketQuote = vi.fn();
const getTowerRegistry = vi.fn();

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return {
    ...actual,
    requireOperator: vi.fn(() => (req: any, _res: any, next: () => void) => {
      req.operator = {
        wallet: "0x0000000000000000000000000000000000000002",
        role: "approver",
        treasuryId: "swap-route-test",
        sessionId: "test-session",
        sessionCreatedAt: new Date(),
      };
      next();
    }),
  };
});

vi.mock("../lib/uniswap-v4", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/uniswap-v4")>();
  return { ...actual, checkVenue, getSwapQuote };
});

vi.mock("../lib/market", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/market")>();
  return { ...actual, getMarketQuote };
});

vi.mock("../lib/tower", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/tower")>();
  return {
    ...actual,
    isTowerConfigured: vi.fn(() => true),
    getTowerRegistry,
  };
});

const { default: app } = await import("../app");

let server: ReturnType<typeof app.listen> | undefined;
let baseUrl = "";

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}/api`;
});

afterAll(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  getTowerRegistry.mockResolvedValue({ available: true, arcSupportsSwaps: true });
  getMarketQuote.mockResolvedValue(quoteFor({ USDC: 1, EURC: 1.16 }));
});

function venue(livePools: unknown[] = []) {
  return {
    reachable: true,
    blockNumber: "123",
    poolManagerDeployed: true,
    quoterDeployed: true,
    routerDeployed: true,
    permit2Deployed: true,
    livePools,
  };
}

describe("treasury swap routes", () => {
  it("disables swaps with the pool reason when no live pool exists", async () => {
    checkVenue.mockResolvedValue(venue());

    const response = await fetch(`${baseUrl}/treasury/swap/venue`);
    expect(response.status).toBe(200);
    const body = await response.json() as { swapEnabled: boolean; reason?: string };
    expect(body.swapEnabled).toBe(false);
    expect(body.reason).toBe("None of Revo's pinned Uniswap v4 pools currently has in-range liquidity");
  });

  it("enables swaps when all contracts and a live pool are present", async () => {
    checkVenue.mockResolvedValue(venue([{
      pair: "EURC/USDC",
      poolId: `0x${"11".repeat(32)}`,
      feeTier: 500,
      tickSpacing: 10,
      liquidity: "1000000",
      tradable: true,
    }]));

    const response = await fetch(`${baseUrl}/treasury/swap/venue`);
    expect(response.status).toBe(200);
    const body = await response.json() as { swapEnabled: boolean };
    expect(body.swapEnabled).toBe(true);
  });

  it("passes independent reference prices into the quote and returns it", async () => {
    const quoted = {
      venue: "uniswap-v4",
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      inputAmount: "100",
      inputBaseUnits: "100000000",
      expectedOutput: "86",
      minOutput: "85.742",
      impliedRate: 0.86,
      referenceRate: 1 / 1.16,
      deviationPct: 0.24,
      priceImpactPct: 0.1,
      feeTier: 500,
      tickSpacing: 10,
      poolId: `0x${"11".repeat(32)}`,
      poolKey: {
        currency0: "0x3600000000000000000000000000000000000000",
        currency1: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1",
        fee: 500,
        tickSpacing: 10,
        hooks: "0x0000000000000000000000000000000000000000",
      },
      poolDepthOut: "1000000",
      slippageBps: 30,
      routerAddress: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
      chainId: 5042,
      tradable: true,
      warnings: [],
      quotedAt: new Date().toISOString(),
    };
    getSwapQuote.mockResolvedValue(quoted);

    const response = await fetch(`${baseUrl}/treasury/swap/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputSymbol: "USDC", outputSymbol: "EURC", amount: "100" }),
    });

    expect(response.status).toBe(200);
    expect(getSwapQuote).toHaveBeenCalledWith({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "100",
      referenceUsd: { input: 1, output: 1.16 },
    });
    expect(await response.json()).toEqual(expect.objectContaining({
      venue: quoted.venue,
      inputSymbol: quoted.inputSymbol,
      outputSymbol: quoted.outputSymbol,
      inputAmount: quoted.inputAmount,
      tradable: true,
      poolId: quoted.poolId,
    }));
  });

  it("withholds a stale reference price so the quote refuses instead of checking against it", async () => {
    // EURC's feed failed its last refresh and is being served from cache. A
    // pool checked against a price that has since moved would pass a bad
    // fill, so the reference is not handed over at all.
    const stale = quoteFor({ USDC: 1, EURC: 1.16 });
    stale.prices["coingecko:euro-coin"]!.stale = true;
    getMarketQuote.mockResolvedValue(stale);
    getSwapQuote.mockImplementation(async (req: { referenceUsd?: unknown }) => ({
      venue: "uniswap-v4",
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      inputAmount: "100",
      inputBaseUnits: "100000000",
      expectedOutput: null,
      minOutput: null,
      impliedRate: null,
      referenceRate: null,
      deviationPct: null,
      priceImpactPct: null,
      feeTier: null,
      tickSpacing: null,
      poolId: null,
      poolKey: null,
      poolDepthOut: null,
      slippageBps: 30,
      routerAddress: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
      chainId: 5042,
      tradable: false,
      reason: req.referenceUsd ? "test: a reference was passed" : "No independent market price was available",
      warnings: [],
      quotedAt: new Date().toISOString(),
    }));

    const response = await fetch(`${baseUrl}/treasury/swap/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputSymbol: "USDC", outputSymbol: "EURC", amount: "100" }),
    });

    expect(response.status).toBe(200);
    const [request] = getSwapQuote.mock.calls[0] as [{ referenceUsd?: unknown }];
    expect(request.referenceUsd).toBeUndefined();
    expect(await response.json()).toMatchObject({ tradable: false, reason: expect.stringContaining("No independent market price") });
  });
});