import { beforeEach, describe, expect, it, vi } from "vitest";

const { getBalances } = vi.hoisted(() => ({ getBalances: vi.fn() }));

vi.mock("@circle-fin/app-kit", () => ({
  AppKit: class {
    unifiedBalance = { getBalances };
  },
}));

import { readCrosschainBalance } from "./appkit";

/**
 * Every case uses a fresh address: the module caches per custody wallet, so
 * reusing one would leak state between tests.
 */
let addressCounter = 0;
function nextAddress(): string {
  addressCounter += 1;
  return `0x${addressCounter.toString(16).padStart(40, "0")}`;
}

function gatewayResponse(address: string, balances: Record<string, string> = {}) {
  const rows = ["Ethereum", "Base", "Arc"].map((chain) => ({
    chain,
    confirmedBalance: balances[chain] ?? "0.000000",
  }));
  const total = rows.reduce((sum, row) => sum + Number(row.confirmedBalance), 0).toFixed(6);
  return {
    token: "USDC",
    totalConfirmedBalance: total,
    breakdown: [{ depositor: address, totalConfirmed: total, breakdown: rows }],
  };
}

beforeEach(() => {
  getBalances.mockReset();
});

describe("Circle Gateway balance reads", () => {
  it("leads with the settlement chain", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValueOnce(gatewayResponse(address));

    const reading = await readCrosschainBalance(address);

    expect(reading.available).toBe(true);
    expect(reading.stale).toBe(false);
    expect(reading.chains[0]?.chain).toBe("Arc");
    expect(reading.chains[0]?.isArc).toBe(true);
    expect(reading.chains[0]?.label).toBe("Arc");
    expect(getBalances).toHaveBeenCalledWith(
      expect.objectContaining({ networkType: "mainnet" }),
    );
  });

  it("reports an empty Gateway as not-deposited rather than as an empty treasury", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValueOnce(gatewayResponse(address));

    const reading = await readCrosschainBalance(address);

    // available means the read succeeded; deposited answers the separate
    // question of whether anything was ever handed to Gateway.
    expect(reading.available).toBe(true);
    expect(reading.deposited).toBe(false);
    expect(reading.totalConfirmed).toBe("0.000000");
  });

  it("marks the treasury as deposited when any chain holds USDC", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValueOnce(gatewayResponse(address, { Base: "12.500000" }));

    const reading = await readCrosschainBalance(address);

    expect(reading.deposited).toBe(true);
    expect(reading.totalConfirmed).toBe("12.500000");
  });
});

describe("failed and malformed Gateway reads", () => {
  it("surfaces a failed read instead of zeros", async () => {
    const address = nextAddress();
    getBalances.mockRejectedValueOnce(new Error("gateway unreachable"));

    const reading = await readCrosschainBalance(address);

    expect(reading.available).toBe(false);
    expect(reading.deposited).toBe(false);
    expect(reading.totalConfirmed).toBeUndefined();
    expect(reading.chains).toEqual([]);
    expect(reading.error).toContain("gateway unreachable");
  });

  it("treats a chain row with no balance as a failed read, not a zero balance", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValueOnce({
      totalConfirmedBalance: "0.000000",
      breakdown: [{ depositor: address, breakdown: [{ chain: "Arc" }] }],
    });

    const reading = await readCrosschainBalance(address);

    expect(reading.available).toBe(false);
    expect(reading.chains).toEqual([]);
    expect(reading.error).toContain("malformed");
  });

  it("refuses a non-decimal total rather than displaying it", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValueOnce({
      totalConfirmedBalance: "unavailable",
      breakdown: [
        { depositor: address, breakdown: [{ chain: "Arc", confirmedBalance: "0.000000" }] },
      ],
    });

    const reading = await readCrosschainBalance(address);

    expect(reading.available).toBe(false);
    expect(reading.totalConfirmed).toBeUndefined();
  });

  it("serves the last good reading marked stale when a refresh fails", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValueOnce(gatewayResponse(address, { Arc: "5.000000" }));
    const good = await readCrosschainBalance(address);
    expect(good.available).toBe(true);

    // Force the cached success to expire without waiting out the success TTL.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 60_000);
    getBalances.mockRejectedValueOnce(new Error("gateway flapped"));
    const stale = await readCrosschainBalance(address);
    vi.useRealTimers();

    expect(stale.available).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.totalConfirmed).toBe("5.000000");
    expect(stale.error).toContain("gateway flapped");
  });
});

describe("caching", () => {
  it("coalesces concurrent callers into a single upstream read", async () => {
    const address = nextAddress();
    let release: ((value: unknown) => void) | undefined;
    getBalances.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = readCrosschainBalance(address);
    const second = readCrosschainBalance(address);
    release?.(gatewayResponse(address));
    const [a, b] = await Promise.all([first, second]);

    expect(getBalances).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("serves a repeat read from cache", async () => {
    const address = nextAddress();
    getBalances.mockResolvedValue(gatewayResponse(address));

    await readCrosschainBalance(address);
    await readCrosschainBalance(address);

    expect(getBalances).toHaveBeenCalledTimes(1);
  });

  it("bounds the address cache so tenant growth cannot leak memory", async () => {
    getBalances.mockImplementation((args: { sources: { address: string }[] }) =>
      Promise.resolve(gatewayResponse(args.sources[0]!.address)),
    );

    const seen: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const address = nextAddress();
      seen.push(address);
      await readCrosschainBalance(address);
    }

    // 300 wallets against a 256-entry cap means the earliest entries must have
    // been evicted, so re-reading them has to hit Gateway again.
    const before = getBalances.mock.calls.length;
    for (const address of seen.slice(0, 60)) await readCrosschainBalance(address);

    expect(getBalances.mock.calls.length).toBeGreaterThan(before);
  });
});
