/**
 * Settlement tests for an approved rebalance.
 *
 * The chain boundary is stubbed so these exercise the decisions rather than
 * the network. What is being pinned down is the difference between "nothing
 * moved" and "something might have moved": get that wrong and a proposal
 * either strands a real trade or gets offered for a second approval after the
 * first one already sent money.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketQuote } from "./market";

const readCustodyHoldings = vi.fn();
const getSynthraQuote = vi.fn();
const readAllowance = vi.fn();
const simulateCustodyCall = vi.fn();
const signCustodyCall = vi.fn();
const broadcastSignedTransfer = vi.fn();
const confirmTransfer = vi.fn();
const gasReserveMicroUsdc = vi.fn();

const HASHES: string[] = [];
function nextHash(): string {
  const hash = `0x${(HASHES.length + 1).toString(16).padStart(64, "0")}`;
  HASHES.push(hash);
  return hash;
}

vi.mock("./holdings", () => ({ readCustodyHoldings }));

vi.mock("./synthra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./synthra")>();
  return { ...actual, getSynthraQuote };
});

vi.mock("./arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arc-chain")>();
  return {
    ...actual,
    ensureTreasuryWallet: vi.fn(async () => ({
      id: "t-1",
      address: "0x2BD4A80730b8cA21D1d523564C58D1B048583Ac0",
    })),
    withCustodyLock: vi.fn(async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    readAllowance,
    simulateCustodyCall,
    signCustodyCall,
    broadcastSignedTransfer,
    confirmTransfer,
    gasReserveMicroUsdc,
  };
});

const { settleRebalance } = await import("./rebalance-execution");
const { ChainError } = await import("./arc-chain");

const TREASURY = "t-1";
/** USDC at 1.00, EURC at 1.16. */
const QUOTE = { usdcUsd: 1, eurUsd: 1.16, ethUsd: 3000 } as MarketQuote;

/** 60/40 split by USD value, with the whole book priceable. */
function holdings(usdcUnits: number, eurcUnits: number, extra: unknown[] = []) {
  return {
    ok: true,
    walletAddress: "0x2BD4A80730b8cA21D1d523564C58D1B048583Ac0",
    readAt: new Date().toISOString(),
    holdings: [
      {
        symbol: "USDC",
        name: "Liquid reserve",
        decimals: 6,
        role: "stable",
        tradable: true,
        address: "0x3600000000000000000000000000000000000000",
        coingeckoId: "usd-coin",
        units: usdcUnits,
        raw: BigInt(Math.round(usdcUnits * 1e6)).toString(),
      },
      {
        symbol: "EURC",
        name: "Euro sleeve",
        decimals: 6,
        role: "risk",
        tradable: true,
        address: "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a",
        coingeckoId: "euro-coin",
        units: eurcUnits,
        raw: BigInt(Math.round(eurcUnits * 1e6)).toString(),
      },
      ...extra,
    ],
  };
}

const TARGETS = [
  { symbol: "USDC", percentage: 50 },
  { symbol: "EURC", percentage: 50 },
];

beforeEach(() => {
  vi.clearAllMocks();
  HASHES.length = 0;
  readCustodyHoldings.mockResolvedValue(holdings(1000, 0));
  // 1 USDC buys 0.85 EURC; floor sits 50 bps below.
  getSynthraQuote.mockImplementation(async (req: { amount: string }) => ({
    tradable: true,
    venue: "synthra",
    feeTier: 3000,
    expectedOutput: (Number(req.amount) * 0.85).toFixed(6),
    minOutput: (Number(req.amount) * 0.85 * 0.995).toFixed(6),
    reason: null,
  }));
  readAllowance.mockResolvedValue(0n);
  simulateCustodyCall.mockResolvedValue(undefined);
  signCustodyCall.mockImplementation(async () => ({
    hash: nextHash(),
    serialized: "0xdeadbeef",
    nonce: 1,
  }));
  broadcastSignedTransfer.mockResolvedValue(undefined);
  confirmTransfer.mockResolvedValue(undefined);
  // ~0.0101 USDC of gas at 400k units.
  gasReserveMicroUsdc.mockResolvedValue(10_080n);
});

describe("settleRebalance", () => {
  it("settles the swap and reports the confirmed transaction", async () => {
    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.inputSymbol).toBe("USDC");
    expect(outcome.settlement.outputSymbol).toBe("EURC");
    // Half the book has to rotate out of USDC to reach a 50/50 split.
    expect(Number(outcome.settlement.amountIn)).toBeCloseTo(500, 2);
    expect(outcome.settlement.txHash).toBe(HASHES[1]);
    expect(outcome.settlement.approvalTxHash).toBe(HASHES[0]);
    expect(outcome.settlement.explorerUrl).toContain(HASHES[1]);
    expect(confirmTransfer).toHaveBeenCalledWith(HASHES[1]);
  });

  it("simulates before it signs, so a revert can still block the send", async () => {
    const order: string[] = [];
    simulateCustodyCall.mockImplementation(async () => void order.push("simulate"));
    signCustodyCall.mockImplementation(async () => {
      order.push("sign");
      return { hash: nextHash(), serialized: "0xdeadbeef", nonce: 1 };
    });
    broadcastSignedTransfer.mockImplementation(async () => void order.push("broadcast"));

    await settleRebalance(TREASURY, TARGETS, QUOTE);

    // Approval and swap each simulate immediately before their own signature.
    expect(order).toEqual([
      "simulate",
      "sign",
      "broadcast",
      "simulate",
      "sign",
      "broadcast",
    ]);
  });

  it("refuses when the swap simulation reverts, without signing anything", async () => {
    readAllowance.mockResolvedValue(10n ** 12n);
    simulateCustodyCall.mockRejectedValue(
      new ChainError("SIMULATION_REVERTED", "Simulation reverted: STF"),
    );

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    expect(signCustodyCall).not.toHaveBeenCalled();
    expect(broadcastSignedTransfer).not.toHaveBeenCalled();
  });

  it("refuses an untradable quote before reaching a signer", async () => {
    getSynthraQuote.mockResolvedValue({
      tradable: false,
      venue: "synthra",
      feeTier: null,
      expectedOutput: null,
      minOutput: null,
      reason: "price impact 9.1% exceeds the 5% ceiling",
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("price impact");
    expect(signCustodyCall).not.toHaveBeenCalled();
  });

  it("skips the approval when the router already has enough allowance", async () => {
    readAllowance.mockResolvedValue(10n ** 12n);

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.approvalTxHash).toBeUndefined();
    expect(signCustodyCall).toHaveBeenCalledTimes(1);
  });

  it("leaves gas behind when selling USDC, because Arc bills gas to that balance", async () => {
    // Target wants everything out of USDC, which is exactly the shape that
    // reverts if the trade is sized at the held balance.
    readCustodyHoldings.mockResolvedValue(holdings(100, 0));
    const outcome = await settleRebalance(
      TREASURY,
      [
        { symbol: "USDC", percentage: 0 },
        { symbol: "EURC", percentage: 100 },
      ],
      QUOTE,
    );

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(Number(outcome.settlement.amountIn)).toBeLessThan(100);
    expect(Number(outcome.settlement.amountIn)).toBeCloseTo(100 - 0.01008, 5);
  });

  it("reports a reverted swap as refused, with the hash, so the proposal stays actionable", async () => {
    confirmTransfer.mockImplementation(async (hash: string) => {
      if (hash === HASHES[0]) return;
      throw new ChainError("TX_REVERTED", "reverted");
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.txHash).toBe(HASHES[1]);
    expect(outcome.reason).toContain("no holdings moved");
  });

  it("reports an unobservable swap as uncertain, never as refused", async () => {
    confirmTransfer.mockImplementation(async (hash: string) => {
      if (hash === HASHES[0]) return;
      throw new ChainError("RPC_UNAVAILABLE", "receipt could not be read");
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind !== "uncertain") return;
    expect(outcome.txHash).toBe(HASHES[1]);
  });

  it("treats an uncertain APPROVAL as refused: granting an allowance moves nothing", async () => {
    broadcastSignedTransfer.mockRejectedValue(
      new ChainError("SEND_UNCERTAIN", "no definitive broadcast result"),
    );

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("position is unchanged");
  });

  it("reports an uncertain SWAP broadcast as uncertain", async () => {
    let broadcasts = 0;
    broadcastSignedTransfer.mockImplementation(async () => {
      broadcasts += 1;
      if (broadcasts === 2) throw new ChainError("SEND_UNCERTAIN", "no definitive result");
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("uncertain");
    if (outcome.kind !== "uncertain") return;
    expect(outcome.txHash).toBe(HASHES[1]);
  });

  it("refuses when Arc cannot be read, rather than sizing against a stale book", async () => {
    readCustodyHoldings.mockResolvedValue({
      ok: false,
      walletAddress: null,
      holdings: [],
      error: "RPC timeout",
      readAt: new Date().toISOString(),
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("RPC timeout");
    expect(getSynthraQuote).not.toHaveBeenCalled();
  });

  it("refuses an empty treasury instead of calling the target trivially met", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(0, 0));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("holds nothing");
  });

  it("refuses when a held asset has no independent price to value it against", async () => {
    readCustodyHoldings.mockResolvedValue(
      holdings(500, 500, [
        {
          symbol: "cirBTC",
          name: "Bitcoin sleeve",
          decimals: 8,
          role: "risk",
          tradable: false,
          address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
          coingeckoId: "bitcoin",
          units: 0.5,
          raw: "50000000",
        },
      ]),
    );
    // CoinGecko omitted BTC on this poll; the denominator is now unknowable.
    const outcome = await settleRebalance(TREASURY, TARGETS, {
      usdcUsd: 1,
      eurUsd: 1.16,
      ethUsd: 3000,
    } as MarketQuote);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("cirBTC");
    expect(signCustodyCall).not.toHaveBeenCalled();
  });

  it("sends nothing when live balances already sit on the target", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(580, 500));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("nothing-to-do");
    expect(signCustodyCall).not.toHaveBeenCalled();
  });

  it("sends nothing for sub-dust drift Synthra cannot price", async () => {
    // A drift worth well under 0.01 USDC.
    readCustodyHoldings.mockResolvedValue(holdings(580.002, 500));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("nothing-to-do");
    if (outcome.kind !== "nothing-to-do") return;
    expect(outcome.reason).toContain("0.01");
    expect(signCustodyCall).not.toHaveBeenCalled();
  });

  it("hands the swap hash to the caller before broadcasting it", async () => {
    const order: string[] = [];
    broadcastSignedTransfer.mockImplementation(async () => void order.push("broadcast"));
    const claim = vi.fn(async (hash: string) => {
      order.push(`claim:${hash}`);
      return true;
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE, claim);

    expect(outcome.kind).toBe("settled");
    // Only the swap is claimed; the allowance approval moves nothing and is
    // not the transaction a reconciler would need to find.
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith(HASHES[1], expect.anything());
    // The hash is durable before the mempool can see the transaction.
    expect(order).toEqual(["broadcast", `claim:${HASHES[1]}`, "broadcast"]);
  });

  it("discards the signed swap unsent when the caller refuses the broadcast", async () => {
    const claim = vi.fn(async () => false);

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE, claim);

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason).toContain("discarded unsent");
    // No hash to chase, because the swap never left this process.
    expect(outcome.txHash).toBeUndefined();
    // The allowance approval was broadcast; the swap was not.
    expect(broadcastSignedTransfer).toHaveBeenCalledTimes(1);
    expect(confirmTransfer).toHaveBeenCalledTimes(1);
    expect(confirmTransfer).not.toHaveBeenCalledWith(HASHES[1]);
  });

  it("never routes the untradable leg, even when it is the furthest from target", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(1000, 0));

    await settleRebalance(TREASURY, TARGETS, QUOTE);

    const [request] = getSynthraQuote.mock.calls[0] as [{ inputSymbol: string; outputSymbol: string }];
    expect(request.inputSymbol).toBe("USDC");
    expect(request.outputSymbol).toBe("EURC");
  });
});
