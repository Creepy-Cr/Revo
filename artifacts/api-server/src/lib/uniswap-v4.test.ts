import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, type Address } from "viem";

const readContract = vi.fn();
const simulateContract = vi.fn();
const getBlockNumber = vi.fn();
const getCode = vi.fn();
const arcPublicClient = vi.fn(() => ({
  readContract,
  simulateContract,
  getBlockNumber,
  getCode,
}));

vi.mock("./arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arc-chain")>();
  return { ...actual, arcPublicClient };
});

const {
  encodePermit2Approval,
  encodeV4Swap,
  getSwapQuote,
  poolIdFor,
} = await import("./uniswap-v4");
const { isTradedSymbol } = await import("./arc-tokens");
const { spotRateFromSqrtPrice } = await import("./uniswap-v4");

const USDC = "0x3600000000000000000000000000000000000000" as Address;
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const KEY = { currency0: USDC, currency1: EURC, fee: 500, tickSpacing: 10, hooks: ZERO };
const POOL_ID = "0xeb0fd02fb8044d5514fb6e165ee134fd547eff0378bb33b76f4b81d8b03bd1ae";
const Q96 = 2n ** 96n;

/** slot0 sqrtPriceX96 for a pool whose fee-adjusted spot is `rate` EURC per USDC (same decimals). */
function sqrtPriceFor(rate: number, fee = 500): bigint {
  const raw = rate / (1 - fee / 1_000_000);
  return BigInt(Math.round(Math.sqrt(raw) * 1e12)) * Q96 / 10n ** 12n;
}

let amountOut = 85_000_000n;
/** The pool sits at 0.85 EURC per USDC after fee unless a test moves it. */
let spot = 0.85;
let liquidity = 10n ** 18n;
let initialized = true;

beforeEach(() => {
  vi.clearAllMocks();
  amountOut = 85_000_000n;
  spot = 0.85;
  liquidity = 10n ** 18n;
  initialized = true;
  readContract.mockImplementation(async (request: any) => {
    const poolId = request.args?.[0];
    const live = initialized && poolId === POOL_ID;
    if (request.functionName === "getSlot0") return [live ? sqrtPriceFor(spot) : 0n, 0, 0, 500];
    if (request.functionName === "getLiquidity") return live ? liquidity : 0n;
    throw new Error(`Unexpected read ${request.functionName}`);
  });
  simulateContract.mockImplementation(async (request: any) => {
    const params = request.args[0];
    if (params.poolKey.fee !== 500) throw new Error("execution reverted");
    return { result: [amountOut, 100_000n] };
  });
});

async function quote(referenceUsd: { input: number; output: number } | undefined = { input: 0.85, output: 1 }) {
  return getSwapQuote({
    inputSymbol: "USDC",
    outputSymbol: "EURC",
    amount: "100",
    ...(referenceUsd ? { referenceUsd } : {}),
  });
}

describe("Uniswap v4 pool identity", () => {
  it("matches the live Arc mainnet USDC/EURC pool id", () => {
    expect(poolIdFor(KEY)).toBe(POOL_ID);
  });

  it("orders currencies numerically regardless of swap direction", async () => {
    await getSwapQuote({
      inputSymbol: "EURC",
      outputSymbol: "USDC",
      amount: "100",
      referenceUsd: { input: 0.85, output: 1 },
    });

    const keys = simulateContract.mock.calls.map((call) => call[0].args[0].poolKey);
    expect(keys.some((key) => key.fee === 500 && key.currency0 === USDC && key.currency1 === EURC)).toBe(true);
  });
});

describe("spot rate from slot0", () => {
  it("reads the marginal rate exactly in both directions and across decimals", () => {
    // 1 USDC (6dp) = 0.00001 cirBTC (8dp) at 100,000 USD per BTC.
    // token1 per token0 in base units: cirBTC is currency0 here? USDC 0x36..
    // sorts below cirBTC 0x17..? No: 0x17 < 0x36, so cirBTC is currency0 and
    // one satoshi is worth 1000 micro-USDC.
    const token1PerToken0 = 1000;
    const sqrtP = BigInt(Math.round(Math.sqrt(token1PerToken0) * 2 ** 48)) * 2n ** 48n;
    const sellBtc = spotRateFromSqrtPrice(sqrtP, true, 0, 8, 6);
    const buyBtc = spotRateFromSqrtPrice(sqrtP, false, 0, 6, 8);
    expect(sellBtc).toBeCloseTo(100_000, 6);
    expect(buyBtc).toBeCloseTo(0.00001, 12);
    // A 30 bps pool hands over 99.7% of that.
    expect(spotRateFromSqrtPrice(sqrtP, true, 3000, 8, 6)).toBeCloseTo(99_700, 6);
  });
});

describe("getSwapQuote safety gates", () => {
  it("reports a failed pool read as an RPC failure, never as an untradable route", async () => {
    readContract.mockRejectedValue(new Error("HTTP request failed: 502"));
    await expect(quote()).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
  });

  it("refuses measured price impact above 1%", async () => {
    amountOut = 83_000_000n;
    const result = await quote();
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("price impact");
  });

  it("refuses reference deviation above 2%", async () => {
    const result = await quote({ input: 0.88, output: 1 });
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("away from the real");
  });

  it("warns when reference deviation is between 1% and 2%", async () => {
    const result = await quote({ input: 0.86, output: 1 });
    expect(result.tradable).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("from the real market rate"))).toBe(true);
  });

  it("refuses output above 10% of measured pool depth", async () => {
    liquidity = 50_000_000n;
    const result = await quote();
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("pool's EURC depth");
  });

  it("refuses without an independent reference price", async () => {
    const result = await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "100",
    });
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("No independent market price");
  });

  it("refuses when no pool is initialized", async () => {
    initialized = false;
    const result = await quote();
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("no USDC/EURC pool");
  });

  it("subtracts 30 bps from expected output and rounds down", async () => {
    amountOut = 123_456_789n;
    spot = 1.2346;
    const result = await quote({ input: 1.23456789, output: 1 });
    expect(result.expectedOutput).toBe("123.456789");
    expect(result.minOutput).toBe("123.086418");
  });

  it("refuses symbols outside the pinned registry", async () => {
    // Arc's v4 carries a token named NVDA minted by an anonymous wallet; the
    // name is not an identity and it is not pinned.
    expect(isTradedSymbol("NVDA")).toBe(false);
    const result = await getSwapQuote({
      inputSymbol: "NVDA",
      outputSymbol: "USDC",
      amount: "1",
      referenceUsd: { input: 1, output: 1 },
    });
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("not an approved Revo token");
  });
});

describe("routing is always through USDC", () => {
  it("refuses a pair with no USDC side before touching the chain", async () => {
    const result = await getSwapQuote({
      inputSymbol: "EURC",
      outputSymbol: "cirBTC",
      amount: "100",
      referenceUsd: { input: 1.16, output: 110_000 },
    });
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("no pinned EURC/cirBTC pool");
    expect(readContract).not.toHaveBeenCalled();
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it("refuses a held-only token as a Revo decision, not a venue answer", async () => {
    const result = await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "wARS",
      amount: "100",
      referenceUsd: { input: 1, output: 0.00066 },
    });
    expect(result.tradable).toBe(false);
    expect(result.reason).toContain("BCRA");
    expect(readContract).not.toHaveBeenCalled();
  });

  it("quotes exactly the pinned pools of the non-USDC side", async () => {
    const { ARC_TOKENS } = await import("./arc-tokens");
    readContract.mockImplementation(async (request: any) => {
      if (request.functionName === "getSlot0") return [Q96, 0, 0, 3000];
      if (request.functionName === "getLiquidity") return 10n ** 18n;
      throw new Error(`Unexpected read ${request.functionName}`);
    });
    simulateContract.mockImplementation(async () => ({ result: [90_000n, 100_000n] }));
    await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "cirBTC",
      amount: "100",
      referenceUsd: { input: 1, output: 110_000 },
    });
    const keys = simulateContract.mock.calls.map((call) => call[0].args[0].poolKey);
    const tiers = new Set(keys.map((k) => `${k.fee}/${k.tickSpacing}`));
    expect([...tiers]).toEqual(ARC_TOKENS.cirBTC.pools.map((p) => `${p.fee}/${p.tickSpacing}`));
    for (const key of keys) {
      expect(key.hooks).toBe(ZERO);
      expect([key.currency0, key.currency1].map((c: string) => c.toLowerCase())).toContain(USDC.toLowerCase());
    }
  });
});

describe("calldata encoding", () => {
  it("encodes Universal Router execute with the supplied deadline", () => {
    const deadline = 2_000_000_000n;
    const data = encodeV4Swap({
      key: KEY,
      input: USDC,
      output: EURC,
      amountIn: 100_000_000n,
      minOut: 84_000_000n,
      deadline,
    });
    expect(data.slice(0, 10)).toBe("0x3593564c");
    const decoded = decodeFunctionData({
      abi: [{
        name: "execute",
        type: "function",
        stateMutability: "payable",
        inputs: [
          { type: "bytes", name: "commands" },
          { type: "bytes[]", name: "inputs" },
          { type: "uint256", name: "deadline" },
        ],
        outputs: [],
      }] as const,
      data,
    });
    expect(decoded.args[2]).toBe(deadline);
  });

  it("encodes Permit2 approve", () => {
    const data = encodePermit2Approval(USDC, 100_000_000n, 2_000_000_000);
    expect(data.slice(0, 10)).toBe("0x87517c45");
  });
});