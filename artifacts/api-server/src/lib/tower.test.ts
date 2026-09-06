import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARC_TRADED_TOKENS,
  checkPairSupport,
  decodeTowerAmount,
  fromBaseUnits,
  getSwapQuote,
  isTowerConfigured,
  resetTowerRegistryCache,
  toBaseUnits,
} from "./tower";

const ARC = 5042002;

const GOOD_CHAINS = {
  success: true,
  data: [
    {
      numericId: ARC,
      name: "Arc Testnet",
      key: "arc-testnet",
      supportedFeatures: ["swaps", "bridge", "rpc-proxy"],
    },
    {
      numericId: 84532,
      name: "Base Sepolia",
      key: "base-sepolia",
      supportedFeatures: ["bridge"],
    },
  ],
};

const GOOD_TOKENS = {
  success: true,
  data: [
    { symbol: "USDC", address: ARC_TRADED_TOKENS["USDC"]!.address, decimals: 6, chainId: ARC },
    { symbol: "cirBTC", address: ARC_TRADED_TOKENS["cirBTC"]!.address, decimals: 8, chainId: ARC },
  ],
};

/**
 * A quote shaped exactly like Tower's real payload, including its
 * 10^(18-decimals) amount scaling. cirBTC has 8 decimals, so its scale is
 * 10^10: an output of 0.5 cirBTC encodes as 5e9.
 */
function towerQuote(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      outputAmount: "5000000000",
      minOut: "4975000000",
      priceImpact: 0.4,
      gasEstimate: "300000",
      slippage: 50,
      feeBps: 25,
      route: {
        hops: [
          {
            dexName: "Tower",
            dexRouter: "0xDf115b4f2F22B9255B2E63348423B6C5B379Bce2",
            path: [ARC_TRADED_TOKENS["USDC"]!.address, ARC_TRADED_TOKENS["cirBTC"]!.address],
            liquidity: "3994281",
          },
        ],
      },
      ...overrides,
    },
  };
}

/** Reference prices that make the fixture quote look like a fair market rate. */
const FAIR_REFERENCE = { input: 1, output: 2 };

function mockTower(quote: unknown = towerQuote(), chains: unknown = GOOD_CHAINS, tokens: unknown = GOOD_TOKENS) {
  const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string }) => {
    const href = typeof url === "string" ? url : url.toString();
    const body =
      href.endsWith("/chains") ? chains : href.endsWith("/tokens") ? tokens : init?.method === "POST" ? quote : null;
    if (body === null) throw new Error(`unexpected request: ${href}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetTowerRegistryCache();
  process.env["TOWER_API_KEY"] = "test-key-not-a-real-credential";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env["TOWER_API_KEY"];
  resetTowerRegistryCache();
});

describe("amount conversion", () => {
  it("converts human amounts into real base units, not Tower's scale", () => {
    // The whole point: 1 USDC is 1e6 base units. Tower would echo 1e12.
    expect(toBaseUnits("1", 6)).toBe(1_000_000n);
    expect(toBaseUnits("1", 8)).toBe(100_000_000n);
    expect(toBaseUnits("1", 18)).toBe(10n ** 18n);
    expect(toBaseUnits("12.5", 6)).toBe(12_500_000n);
    expect(toBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("rejects amounts that cannot be represented exactly", () => {
    expect(toBaseUnits("0.0000001", 6)).toBeNull();
    expect(toBaseUnits("abc", 6)).toBeNull();
    expect(toBaseUnits("-1", 6)).toBeNull();
    expect(toBaseUnits("1e6", 6)).toBeNull();
    expect(toBaseUnits("", 6)).toBeNull();
  });

  it("round-trips base units back to a human string", () => {
    expect(fromBaseUnits(1_000_000n, 6)).toBe("1");
    expect(fromBaseUnits(12_500_000n, 6)).toBe("12.5");
    expect(fromBaseUnits(1n, 6)).toBe("0.000001");
    expect(fromBaseUnits(0n, 6)).toBe("0");
  });

  it("decodes Tower's 10^(18-decimals) scaling", () => {
    // Verified against the live API: 1 USDC echoes as 1e12, 1 cirBTC as 1e10,
    // 1 USDT (18dp) as 1.
    expect(decodeTowerAmount("1000000000000", 6)).toBe("1");
    expect(decodeTowerAmount("10000000000", 8)).toBe("1");
    expect(decodeTowerAmount("1", 18)).toBe("1");
    expect(decodeTowerAmount("5000000000", 8)).toBe("0.5");
  });

  it("refuses to decode a non-numeric amount", () => {
    expect(decodeTowerAmount("0x1", 6)).toBeNull();
    expect(decodeTowerAmount(undefined, 6)).toBeNull();
    expect(decodeTowerAmount("1.5", 6)).toBeNull();
  });
});

describe("configuration", () => {
  it("reports configuration without revealing the key", () => {
    expect(isTowerConfigured()).toBe(true);
    delete process.env["TOWER_API_KEY"];
    expect(isTowerConfigured()).toBe(false);
  });

  it("refuses to quote when no key is configured", async () => {
    delete process.env["TOWER_API_KEY"];
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/not configured/i);
  });
});

describe("pair support", () => {
  it("accepts an approved pair that Tower still lists", async () => {
    mockTower();
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(true);
    expect(support.arcSupportsSwaps).toBe(true);
  });

  it("rejects a token Revo has not approved", async () => {
    mockTower();
    const support = await checkPairSupport("USDC", "WETH");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/not an approved/i);
  });

  it("rejects an identical input and output", async () => {
    mockTower();
    const support = await checkPairSupport("USDC", "USDC");
    expect(support.supported).toBe(false);
  });

  it("stops when Tower reports a different contract address than Revo pinned", async () => {
    mockTower(towerQuote(), GOOD_CHAINS, {
      success: true,
      data: [
        { symbol: "USDC", address: ARC_TRADED_TOKENS["USDC"]!.address, decimals: 6, chainId: ARC },
        { symbol: "cirBTC", address: "0x000000000000000000000000000000000000dead", decimals: 8, chainId: ARC },
      ],
    });
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/different contract address/i);
  });

  it("stops when Tower reports different decimals than Revo pinned", async () => {
    mockTower(towerQuote(), GOOD_CHAINS, {
      success: true,
      data: [
        { symbol: "USDC", address: ARC_TRADED_TOKENS["USDC"]!.address, decimals: 6, chainId: ARC },
        { symbol: "cirBTC", address: ARC_TRADED_TOKENS["cirBTC"]!.address, decimals: 18, chainId: ARC },
      ],
    });
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/decimals/i);
  });

  it("stops when Arc no longer advertises swap support", async () => {
    mockTower(towerQuote(), {
      success: true,
      data: [{ numericId: ARC, name: "Arc Testnet", key: "arc-testnet", supportedFeatures: ["bridge"] }],
    });
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/no longer reports swap support/i);
  });

  it("refuses a registry that answers HTTP 200 with success false", async () => {
    mockTower(towerQuote(), { success: false, error: "chain list unavailable" }, GOOD_TOKENS);
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(false);
    expect(support.registryAvailable).toBe(false);
  });

  it("discards malformed token entries instead of trusting them", async () => {
    mockTower(towerQuote(), GOOD_CHAINS, {
      success: true,
      data: [
        { symbol: "USDC", address: ARC_TRADED_TOKENS["USDC"]!.address, decimals: 6, chainId: ARC },
        // No address field: previously this reached .toLowerCase() and threw.
        { symbol: "cirBTC", decimals: 8, chainId: ARC },
      ],
    });
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(false);
    expect(support.reason).toMatch(/no longer lists cirBTC/i);
  });

  it("surfaces an unreachable registry instead of assuming support", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const support = await checkPairSupport("USDC", "cirBTC");
    expect(support.supported).toBe(false);
    expect(support.registryAvailable).toBe(false);
  });
});

describe("quoting", () => {
  it("prices a healthy route and computes base units independently of Tower", async () => {
    mockTower();
    const quote = await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "cirBTC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(quote.tradable).toBe(true);
    // 1 USDC in real base units, NOT Tower's 1e12.
    expect(quote.inputBaseUnits).toBe("1000000");
    expect(quote.indicativeOutput).toBe("0.5");
    expect(quote.indicativeMinOut).toBe("0.4975");
    expect(quote.routerAddress).toBe("0xDf115b4f2F22B9255B2E63348423B6C5B379Bce2");
    expect(quote.warnings.some((w) => /confirmed on-chain/i.test(w))).toBe(true);
  });

  it("refuses a route Tower prices at zero output", async () => {
    mockTower(towerQuote({ outputAmount: "0", minOut: "0" }));
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/no usable liquidity/i);
  });

  it("refuses a route with no minimum-output floor", async () => {
    mockTower(towerQuote({ minOut: "0" }));
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/minimum-output floor/i);
  });

  it("refuses a hop Tower itself reports as having zero liquidity", async () => {
    mockTower(
      towerQuote({
        route: {
          hops: [
            {
              dexName: "Synthra",
              dexRouter: "0xDf115b4f2F22B9255B2E63348423B6C5B379Bce2",
              path: [],
              liquidity: "0",
            },
          ],
        },
      }),
    );
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/zero liquidity/i);
  });

  it("refuses a route above the price impact ceiling", async () => {
    mockTower(towerQuote({ priceImpact: 30 }));
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/price impact/i);
  });

  it("refuses a pool priced far away from the real market", async () => {
    mockTower();
    // Fixture implies 0.5 cirBTC per USDC. A reference where cirBTC is worth
    // vastly more makes that rate nonsense, which is the live testnet failure.
    const quote = await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "cirBTC",
      amount: "1",
      referenceUsd: { input: 1, output: 100_000 },
    });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/away from the real/i);
  });

  it("fails closed when no independent reference price is available", async () => {
    mockTower();
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/no independent market price/i);
  });

  it("fails closed on a non-finite reference price rather than dividing by it", async () => {
    mockTower();
    for (const reference of [
      { input: 0, output: 2 },
      { input: 1, output: 0 },
      { input: Number.NaN, output: 2 },
      { input: 1, output: Number.POSITIVE_INFINITY },
    ]) {
      const quote = await getSwapQuote({
        inputSymbol: "USDC",
        outputSymbol: "cirBTC",
        amount: "1",
        referenceUsd: reference,
      });
      expect(quote.tradable).toBe(false);
      expect(quote.reason).toMatch(/no independent market price/i);
    }
  });

  it("warns when the pool drifts from the reference without breaching the ceiling", async () => {
    mockTower();
    // Implied rate is 0.5; a reference of 0.575 is a 13% gap, over the warn
    // threshold but under the refusal ceiling.
    const quote = await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "cirBTC",
      amount: "1",
      referenceUsd: { input: 1.15, output: 2 },
    });
    expect(quote.tradable).toBe(true);
    expect(quote.warnings.some((w) => /from the real market rate/i.test(w))).toBe(true);
  });

  it("refuses an unparseable amount before calling Tower", async () => {
    const fetchMock = mockTower();
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "0.0000001" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/not a valid/i);
    // Registry reads are allowed; the quote call itself must not happen.
    expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === "POST")).toBe(
      false,
    );
  });

  it("refuses a fractional amount before Tower can crash on it", async () => {
    const fetchMock = mockTower();
    const quote = await getSwapQuote({ inputSymbol: "cirBTC", outputSymbol: "USDC", amount: "0.5" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/whole-number amounts/i);
    expect(fetchMock.mock.calls.some(([, init]) => (init as { method?: string } | undefined)?.method === "POST")).toBe(
      false,
    );
  });

  it("refuses a zero amount", async () => {
    mockTower();
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "0" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/greater than zero/i);
  });

  it("passes Tower's own error through when it finds no route", async () => {
    mockTower({ success: false, error: "No valid route found" });
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toBe("No valid route found");
  });

  it("never leaks the API key in an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream exploded", { status: 500 })),
    );
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(JSON.stringify(quote)).not.toContain("test-key-not-a-real-credential");
  });

  it("redacts the key when the upstream reflects it back in an error body", async () => {
    // A hostile or careless upstream echoing the Authorization header would
    // otherwise turn a pass-through error message into a key disclosure.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: "rejected request with Bearer test-key-not-a-real-credential",
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const quote = await getSwapQuote({ inputSymbol: "USDC", outputSymbol: "cirBTC", amount: "1" });
    expect(quote.tradable).toBe(false);
    expect(JSON.stringify(quote)).not.toContain("test-key-not-a-real-credential");
    expect(quote.reason).toMatch(/redacted/i);
  });

  it("refuses an absurdly long amount rather than losing precision on it", async () => {
    mockTower();
    const quote = await getSwapQuote({
      inputSymbol: "USDC",
      outputSymbol: "cirBTC",
      amount: "9".repeat(40),
      referenceUsd: FAIR_REFERENCE,
    });
    expect(quote.tradable).toBe(false);
    expect(quote.reason).toMatch(/not a valid/i);
  });
});
