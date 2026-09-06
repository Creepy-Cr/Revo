import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Arc RPC is stubbed at the viem boundary so these tests exercise the
 * guards rather than the network. Each case controls what the factory, quoter
 * and token contracts answer, which is the only way to reach failure modes a
 * live testnet will not reproduce on demand.
 */

interface PoolConfig {
  /** Fee tiers that have a deployed pool. */
  tiers: Record<number, { rate: number; spotRate?: number; reserveOut: number }>;
  factoryThrows?: boolean;
  quoterThrows?: boolean;
  rpcThrows?: boolean;
}

let pools: PoolConfig = { tiers: {} };

const USDC_DECIMALS = 6;
const EURC_DECIMALS = 6;

function scaled(human: number, decimals: number): bigint {
  return BigInt(Math.round(human * 10 ** decimals));
}

const readContract = vi.fn(async (args: Record<string, unknown>) => {
  if (pools.rpcThrows) throw new Error("arc rpc down");
  const fn = args["functionName"] as string;
  const callArgs = args["args"] as unknown[];

  if (fn === "getPool") {
    if (pools.factoryThrows) throw new Error("factory reverted");
    const fee = Number(callArgs[2]);
    return pools.tiers[fee]
      ? `0x${fee.toString(16).padStart(40, "0")}`
      : "0x0000000000000000000000000000000000000000";
  }
  if (fn === "quoteExactInputSingle") {
    if (pools.quoterThrows) throw new Error("quoter reverted");
    const params = callArgs[0] as { amountIn: bigint; fee: number };
    const tier = pools.tiers[Number(params.fee)];
    if (!tier) throw new Error("no pool");
    // 0.01 of an input token is the dust probe; anything larger is the order.
    const dust = 10n ** BigInt(USDC_DECIMALS - 2);
    const rate = params.amountIn <= dust ? (tier.spotRate ?? tier.rate) : tier.rate;
    const human = (Number(params.amountIn) / 10 ** USDC_DECIMALS) * rate;
    return [scaled(human, EURC_DECIMALS), 0n, 0, 0n];
  }
  if (fn === "balanceOf") {
    const tier = Object.values(pools.tiers)[0];
    return scaled(tier?.reserveOut ?? 0, EURC_DECIMALS);
  }
  throw new Error(`unexpected call ${fn}`);
});

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      readContract,
      getBlockNumber: async () => 123n,
      getBytecode: async () => "0xdeadbeef",
    }),
  };
});

const { getSynthraQuote, checkSynthraVenue, resetSynthraClient, SLIPPAGE_BPS } = await import(
  "./synthra"
);

/** USDC at 1.00 and EURC at 1.16 imply 0.862 EURC per USDC. */
const FAIR_REFERENCE = { input: 1, output: 1.16 };

function setPools(config: PoolConfig): void {
  pools = config;
}

beforeEach(() => {
  readContract.mockClear();
  resetSynthraClient();
  setPools({ tiers: { 3000: { rate: 0.85, reserveOut: 1000 } } });
});

describe("getSynthraQuote", () => {
  it("prices a healthy route and derives its own execution floor", async () => {
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(true);
    expect(q.expectedOutput).toBe("0.85");
    expect(q.feeTier).toBe(3000);
    expect(q.venue).toBe("synthra");
    // The floor is computed locally from the quote, never taken from a venue.
    const expectedFloor = (0.85 * (10_000 - SLIPPAGE_BPS)) / 10_000;
    expect(Number(q.minOutput)).toBeCloseTo(expectedFloor, 6);
  });

  it("quotes a fractional amount, which the aggregator cannot do at all", async () => {
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "0.01",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(true);
    expect(Number(q.expectedOutput)).toBeCloseTo(0.0085, 8);
  });

  it("refuses a token Revo has marked untradable, with the measured reason", async () => {
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "cirBTC",
      amount: "1",
      referenceUsd: { input: 1, output: 79000 },
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/deepest cirBTC pool/i);
    // Refused before any network call, so a dead pool costs nothing to reject.
    expect(readContract).not.toHaveBeenCalled();
  });

  it("refuses an unknown symbol", async () => {
    const q = await getSynthraQuote({ inputSymbol: "USDC", outputSymbol: "DOGE", amount: "1" });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/not an approved Revo token/i);
  });

  it("refuses a swap of a token for itself", async () => {
    const q = await getSynthraQuote({ inputSymbol: "USDC", outputSymbol: "USDC", amount: "1" });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/same/i);
  });

  it.each([["abc"], [""], ["1e5"], ["-1"]])("refuses the malformed amount %s", async (amount) => {
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount,
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
  });

  it("refuses a zero amount", async () => {
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "0",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/greater than zero/i);
  });

  it("reports plainly when no pool exists for the pair", async () => {
    setPools({ tiers: {} });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/no USDC\/EURC pool/i);
  });

  it("distinguishes a pool that quotes nothing from a pool that is absent", async () => {
    setPools({ tiers: { 3000: { rate: 0, reserveOut: 1000 } } });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/quoted zero output/i);
  });

  it("picks the fee tier that returns the most output", async () => {
    setPools({
      tiers: {
        500: { rate: 0.8, reserveOut: 1000 },
        3000: { rate: 0.86, reserveOut: 1000 },
        10000: { rate: 0.82, reserveOut: 1000 },
      },
    });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(true);
    expect(q.feeTier).toBe(3000);
    expect(q.expectedOutput).toBe("0.86");
  });

  it("fails closed when no independent reference price is available", async () => {
    const q = await getSynthraQuote({ inputSymbol: "USDC", outputSymbol: "EURC", amount: "1" });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/no independent market price/i);
  });

  it.each([
    [{ input: 0, output: 1.16 }],
    [{ input: 1, output: 0 }],
    [{ input: Number.NaN, output: 1.16 }],
    [{ input: 1, output: Number.POSITIVE_INFINITY }],
  ])("fails closed on the non-finite reference %j", async (referenceUsd) => {
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/no independent market price/i);
  });

  it("refuses a pool priced far from the real market", async () => {
    setPools({ tiers: { 3000: { rate: 0.5, reserveOut: 1000 } } });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/away from the real USDC\/EURC market rate/i);
    expect(q.deviationPct).toBeGreaterThan(25);
  });

  it("warns but still trades when the pool drifts under the ceiling", async () => {
    setPools({ tiers: { 3000: { rate: 0.75, reserveOut: 1000 } } });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(true);
    expect(q.warnings.some((w) => /not a market rate/i.test(w))).toBe(true);
  });

  it("refuses on measured price impact rather than a reported figure", async () => {
    // Dust quotes at 0.85 but the real order fills at 0.80: 5.9% impact.
    setPools({ tiers: { 3000: { rate: 0.8, spotRate: 0.85, reserveOut: 1000 } } });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/measured price impact/i);
    expect(q.priceImpactPct).toBeGreaterThan(5);
  });

  it("refuses a trade that would take too much of the pool", async () => {
    setPools({ tiers: { 3000: { rate: 0.85, reserveOut: 5 } } });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/of the pool's EURC/i);
  });

  it("surfaces an RPC failure instead of reporting no liquidity", async () => {
    setPools({ tiers: { 3000: { rate: 0.85, reserveOut: 1000 } }, rpcThrows: true });
    const q = await getSynthraQuote({
      inputSymbol: "USDC",
      outputSymbol: "EURC",
      amount: "1",
      referenceUsd: FAIR_REFERENCE,
    });
    expect(q.tradable).toBe(false);
    expect(q.reason).toMatch(/no USDC\/EURC pool|rpc/i);
  });

  it("never marks a refused quote tradable, whatever the reason", async () => {
    const configs: PoolConfig[] = [
      { tiers: {} },
      { tiers: { 3000: { rate: 0, reserveOut: 1000 } } },
      { tiers: { 3000: { rate: 0.5, reserveOut: 1000 } } },
      { tiers: { 3000: { rate: 0.85, reserveOut: 1 } } },
    ];
    for (const config of configs) {
      setPools(config);
      const q = await getSynthraQuote({
        inputSymbol: "USDC",
        outputSymbol: "EURC",
        amount: "1",
        referenceUsd: FAIR_REFERENCE,
      });
      expect(q.tradable).toBe(false);
      expect(q.reason).toBeTruthy();
    }
  });
});

describe("checkSynthraVenue", () => {
  it("reports the contracts as deployed when they carry code", async () => {
    const v = await checkSynthraVenue();
    expect(v.reachable).toBe(true);
    expect(v.factoryDeployed).toBe(true);
    expect(v.quoterDeployed).toBe(true);
    expect(v.routerDeployed).toBe(true);
    expect(v.blockNumber).toBe("123");
  });
});
