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
const getSwapQuote = vi.fn();
const readPermit2Allowance = vi.fn();
const encodePermit2Approval = vi.fn(() => "0x2222");
const encodeV4Swap = vi.fn(() => "0x3333");
const readAllowance = vi.fn();
const simulateCustodyCall = vi.fn();
const signCustodyCall = vi.fn();
const broadcastSignedTransfer = vi.fn();
const confirmTransfer = vi.fn();
const getConfirmedReceipt = vi.fn();
const gasReserveMicroUsdc = vi.fn();

const HASHES: string[] = [];
/** Base units of the last quoted input, so exact-allowance fixtures can match it. */
let quotedBaseUnits = 0n;
function nextHash(): string {
  const hash = `0x${(HASHES.length + 1).toString(16).padStart(64, "0")}`;
  HASHES.push(hash);
  return hash;
}

const WALLET = "0x2BD4A80730b8cA21D1d523564C58D1B048583Ac0";
const USDC = "0x3600000000000000000000000000000000000000";
const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const CIRBTC = "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF";
const POOL = "0x1111111111111111111111111111111111111111";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A real ERC-20 `Transfer` log, encoded the way a swap receipt carries one. */
function transferLog(token: string, to: string, value: bigint) {
  const asTopic = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
  return {
    address: token,
    topics: [TRANSFER_TOPIC, asTopic(POOL), asTopic(to)],
    data: `0x${value.toString(16).padStart(64, "0")}`,
  };
}

/** A confirmed receipt carrying the transfers a swap emitted. */
function receipt(...logs: ReturnType<typeof transferLog>[]) {
  return { status: "success", logs };
}

/** Arc's gas price in wei, the same one the gas reserve is derived from. */
const GAS_PRICE_WEI = 25_200_000_000n;

/** A receipt that also says what Arc billed the wallet for the transaction. */
function billedReceipt(gasUsed: bigint, ...logs: ReturnType<typeof transferLog>[]) {
  return { ...receipt(...logs), gasUsed, effectiveGasPrice: GAS_PRICE_WEI };
}

vi.mock("./holdings", () => ({ readCustodyHoldings }));
vi.mock("./custody-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./custody-policy")>();
  return { ...actual, assertRebalanceCaps: vi.fn(async () => undefined) };
});

vi.mock("./arc-chain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arc-chain")>();
  return {
    ...actual,
    ensureTreasuryWallet: vi.fn(async () => ({ id: "t-1", address: WALLET })),
    withCustodyLock: vi.fn(async (_id: string, fn: (tx: unknown) => Promise<unknown>) => fn({})),
    readAllowance,
    simulateCustodyCall,
    signCustodyCall,
    broadcastSignedTransfer,
    confirmTransfer,
    getConfirmedReceipt,
    gasReserveMicroUsdc,
  };
});

vi.mock("./uniswap-v4", () => {
  return {
    PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    UNIVERSAL_ROUTER: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
    SWAP_DEADLINE_SECONDS: 180,
    getSwapQuote,
    readPermit2Allowance,
    encodePermit2Approval,
    encodeV4Swap,
  };
});

const { settleRebalance, readFillFromReceipt } = await import("./rebalance-execution");
const { ChainError } = await import("./arc-chain");

const TREASURY = "t-1";
/** USDC at 1.00, EURC at 1.16. */
const QUOTE = { usdcUsd: 1, eurUsd: 1.16 } as MarketQuote;

/** 60/40 split by USD value, with the whole book priceable. */
function holdings(usdcUnits: number, eurcUnits: number, extra: unknown[] = []) {
  return {
    ok: true,
    walletAddress: WALLET,
    readAt: new Date().toISOString(),
    holdings: [
      {
        symbol: "USDC",
        name: "Liquid reserve",
        decimals: 6,
        role: "stable",
        tradable: true,
        address: USDC,
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
        address: EURC,
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
  getSwapQuote.mockImplementation(async (req: { inputSymbol: string; outputSymbol: string; amount: string }) => {
    quotedBaseUnits = BigInt(Math.round(Number(req.amount) * 1e6));
    return quoteFor(req);
  });
  const quoteFor = (req: { inputSymbol: string; outputSymbol: string; amount: string }) => ({
    tradable: true,
    venue: "uniswap-v4",
    inputSymbol: req.inputSymbol,
    outputSymbol: req.outputSymbol,
    inputAmount: req.amount,
    inputBaseUnits: (BigInt(Math.round(Number(req.amount) * 1e6))).toString(),
    feeTier: 500,
    tickSpacing: 10,
    poolId: `0x${"11".repeat(32)}`,
    poolKey: {
      currency0: USDC,
      currency1: EURC,
      fee: 500,
      tickSpacing: 10,
      hooks: "0x0000000000000000000000000000000000000000",
    },
    poolDepthOut: "10000000",
    expectedOutput: (Number(req.amount) * 0.85).toFixed(6),
    minOutput: (Number(req.amount) * 0.85 * 0.997).toFixed(6),
    impliedRate: 0.85,
    referenceRate: 1 / 1.16,
    deviationPct: 1,
    priceImpactPct: 0.1,
    slippageBps: 30,
    routerAddress: "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
    chainId: 5042,
    warnings: [],
    quotedAt: new Date().toISOString(),
  });
  // Keep one preparatory transaction by default: ERC-20 already allows
  // Permit2 exactly this trade, while Permit2 still needs to allow the
  // Universal Router. Approvals are exact, so "sufficient" means equal.
  readAllowance.mockImplementation(async () => quotedBaseUnits);
  readPermit2Allowance.mockResolvedValue({ amount: 0n, expiration: 0 });
  simulateCustodyCall.mockResolvedValue(undefined);
  signCustodyCall.mockImplementation(async () => ({
    hash: nextHash(),
    serialized: "0xdeadbeef",
    nonce: 1,
  }));
  broadcastSignedTransfer.mockResolvedValue(undefined);
  // Nothing readable from the receipt unless a test says otherwise, so no
  // test passes on a fill the chain never actually evidenced.
  confirmTransfer.mockResolvedValue(undefined);
  getConfirmedReceipt.mockResolvedValue(null);
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
    readAllowance.mockImplementation(async () => quotedBaseUnits);
    simulateCustodyCall.mockRejectedValue(
      new ChainError("SIMULATION_REVERTED", "Simulation reverted: STF"),
    );

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    expect(signCustodyCall).not.toHaveBeenCalled();
    expect(broadcastSignedTransfer).not.toHaveBeenCalled();
  });

  it("refuses an untradable quote before reaching a signer", async () => {
    getSwapQuote.mockResolvedValue({
      tradable: false,
      venue: "uniswap-v4",
      feeTier: null,
      poolKey: null,
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

  it("sends no approvals when both allowances are sufficient and unexpired", async () => {
    readAllowance.mockImplementation(async () => quotedBaseUnits);
    readPermit2Allowance.mockImplementation(async () => ({
      amount: quotedBaseUnits,
      expiration: Math.floor(Date.now() / 1000) + 1_000,
    }));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.approvalTxHash).toBeUndefined();
    expect(signCustodyCall).toHaveBeenCalledTimes(1);
  });

  it("renews Permit2 when its amount is sufficient but it expires before the swap deadline", async () => {
    readAllowance.mockImplementation(async () => quotedBaseUnits);
    readPermit2Allowance.mockImplementation(async () => ({
      amount: quotedBaseUnits,
      expiration: Math.floor(Date.now() / 1000) + 60,
    }));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    expect(encodePermit2Approval).toHaveBeenCalledOnce();
    expect(signCustodyCall).toHaveBeenCalledTimes(2);
  });

  it("targets token then Permit2 for approvals and the Universal Router for the swap", async () => {
    readAllowance.mockResolvedValue(0n);
    readPermit2Allowance.mockResolvedValue({ amount: 0n, expiration: 0 });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    const targets = simulateCustodyCall.mock.calls.map((call) => call[1]);
    expect(targets).toEqual([
      USDC,
      "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      "0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1",
    ]);
  });

  it("refuses a quote with no pool key without signing", async () => {
    getSwapQuote.mockResolvedValue({
      tradable: true,
      venue: "uniswap-v4",
      minOutput: "1",
      expectedOutput: "1",
      feeTier: 500,
      poolKey: null,
      reason: "pool key unavailable",
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("refused");
    expect(signCustodyCall).not.toHaveBeenCalled();
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
    expect(getSwapQuote).not.toHaveBeenCalled();
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

  it("sends nothing for sub-dust drift the venue cannot price", async () => {
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

  it("records what the swap actually returned, not only what the quote expected", async () => {
    // Sized against 1000 USDC, then read back after the swap: 500 USDC left
    // (less the gas Arc billed) and a fill that landed just under the quote.
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(1000, 0))
      .mockResolvedValueOnce(holdings(499.98992, 424.15));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.expectedOutput).toBe("425.000000");
    expect(outcome.settlement.realisedOutput).toBe("424.15");
    // 425 quoted, 424.15 received: 0.2% of the quote, well inside the floor.
    expect(outcome.settlement.realisedSlippagePct).toBeCloseTo(0.2, 3);
    // Where the book actually landed, not the 50/50 that was aimed for.
    expect(outcome.settlement.holdingsAfter).toEqual([
      { symbol: "USDC", units: "499.98992", percentage: 50.4 },
      { symbol: "EURC", units: "424.15", percentage: 49.6 },
    ]);
    expect(outcome.settlement.realisedNote).toBeUndefined();
  });

  it("takes the fill from the swap receipt rather than the balance around it", async () => {
    // The balance delta says 424.15 EURC. The receipt says what the router
    // actually paid out, and that is the figure with no distortions in it.
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(1000, 0))
      .mockResolvedValueOnce(holdings(499.98992, 424.15));
    confirmTransfer.mockResolvedValue(receipt(transferLog(EURC, WALLET, 424_400_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.realisedOutput).toBe("424.4");
    // 425 quoted against the receipt's 424.4, not against the balance's 424.15.
    expect(outcome.settlement.realisedSlippagePct).toBeCloseTo(0.141, 3);
    expect(outcome.settlement.realisedNote).toBeUndefined();
  });

  it("reports a USDC fill gross, with no gas caveat left to make", async () => {
    // Selling the euro sleeve back into USDC, the balance Arc bills gas to.
    // The wallet is 424.9 up; the router paid 424.91 and gas took the rest.
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(0, 1000))
      .mockResolvedValueOnce(holdings(424.9, 500));
    confirmTransfer.mockResolvedValue(receipt(transferLog(USDC, WALLET, 424_910_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.outputSymbol).toBe("USDC");
    expect(outcome.settlement.realisedOutput).toBe("424.91");
    // The bias the caveat existed to warn about is not in this figure.
    expect(outcome.settlement.realisedNote).toBeUndefined();
  });

  it("falls back to the balance delta, caveat and all, when the receipt shows no fill", async () => {
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(0, 1000))
      .mockResolvedValueOnce(holdings(424.9, 500));
    // A payout to anywhere other than the custody wallet is not this fill.
    confirmTransfer.mockResolvedValue(receipt(transferLog(USDC, POOL, 424_910_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.realisedOutput).toBe("424.9");
    expect(outcome.settlement.realisedNote).toContain("net of the Arc gas");
  });

  it("still reports the fill when the post-trade holdings read fails", async () => {
    readCustodyHoldings.mockResolvedValueOnce(holdings(1000, 0)).mockResolvedValueOnce({
      ok: false,
      walletAddress: null,
      holdings: [],
      error: "RPC timeout",
      readAt: new Date().toISOString(),
    });
    confirmTransfer.mockResolvedValue(receipt(transferLog(EURC, WALLET, 424_400_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    // The fill came off the receipt, so it does not depend on a second read.
    expect(outcome.settlement.realisedOutput).toBe("424.4");
    expect(outcome.settlement.realisedSlippagePct).toBeCloseTo(0.141, 3);
    // Where the book landed genuinely is unknown, and says so.
    expect(outcome.settlement.holdingsAfter).toEqual([]);
    expect(outcome.settlement.realisedNote).toContain("unknown rather than unchanged");
  });

  it("survives a receipt it cannot parse, by measuring the balance instead", async () => {
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(1000, 0))
      .mockResolvedValueOnce(holdings(499.98992, 424.15));
    confirmTransfer.mockResolvedValue({ status: "success", logs: [{ nonsense: true }] });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.realisedOutput).toBe("424.15");
  });

  it("reports a fill that beat the quote as negative slippage", async () => {
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(1000, 0))
      .mockResolvedValueOnce(holdings(499.98992, 426.7));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.realisedOutput).toBe("426.7");
    expect(outcome.settlement.realisedSlippagePct).toBeCloseTo(-0.4, 3);
  });

  it("says the received figure is net of gas when the fill lands in the gas asset", async () => {
    // Selling the euro sleeve back into USDC, which is the balance Arc bills
    // gas to, so the measured delta is the fill minus this trade's gas.
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(0, 1000))
      .mockResolvedValueOnce(holdings(424.9, 500));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.outputSymbol).toBe("USDC");
    expect(outcome.settlement.realisedOutput).toBe("424.9");
    expect(outcome.settlement.realisedNote).toContain("net of the Arc gas");
  });

  it("keeps the settlement settled when holdings cannot be re-read afterwards", async () => {
    readCustodyHoldings.mockResolvedValueOnce(holdings(1000, 0)).mockResolvedValueOnce({
      ok: false,
      walletAddress: null,
      holdings: [],
      error: "RPC timeout",
      readAt: new Date().toISOString(),
    });

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    // The swap confirmed. A failed read is a failed read: it cannot unsettle a
    // trade that already happened, and it is never a zero fill.
    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.txHash).toBe(HASHES[1]);
    expect(outcome.settlement.realisedOutput).toBeNull();
    expect(outcome.settlement.realisedSlippagePct).toBeNull();
    expect(outcome.settlement.holdingsAfter).toEqual([]);
    expect(outcome.settlement.realisedNote).toContain("RPC timeout");
    expect(outcome.settlement.realisedNote).toContain("unknown rather than unchanged");
  });

  it("survives a post-trade read that throws outright", async () => {
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(1000, 0))
      .mockRejectedValueOnce(new Error("socket hang up"));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.realisedOutput).toBeNull();
    expect(outcome.settlement.realisedNote).toContain("socket hang up");
  });

  it("calls an unmoved output balance unmeasurable rather than a zero fill", async () => {
    // The post-trade read shows no more EURC than before - another transfer
    // in the same window, or a stale node. Either way it is not a zero fill.
    readCustodyHoldings.mockResolvedValue(holdings(1000, 0));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.realisedOutput).toBeNull();
    expect(outcome.settlement.realisedSlippagePct).toBeNull();
    expect(outcome.settlement.realisedNote).toContain("could not be measured");
    // The composition itself was read fine, so it is still reported.
    expect(outcome.settlement.holdingsAfter).toEqual([
      { symbol: "USDC", units: "1000", percentage: 100 },
    ]);
  });

  it("withholds the post-trade split when part of the book has no price", async () => {
    const unpricedBtc = {
      symbol: "cirBTC",
      name: "Bitcoin sleeve",
      decimals: 8,
      role: "risk",
      tradable: false,
      address: "0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF",
      coingeckoId: "bitcoin",
      units: 0.5,
      raw: "50000000",
    };
    readCustodyHoldings
      .mockResolvedValueOnce(holdings(1000, 0))
      .mockResolvedValueOnce(holdings(499.98992, 424.15, [unpricedBtc]));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    // Units are facts; a split over a book that cannot be fully valued is not.
    expect(outcome.settlement.realisedOutput).toBe("424.15");
    expect(outcome.settlement.holdingsAfter.map((h) => h.percentage)).toEqual([null, null, null]);
    expect(outcome.settlement.realisedNote).toContain("cirBTC");
  });

  it("records what the rebalance paid Arc in gas, out of the treasury's own balance", async () => {
    // The router is already allowed, so the swap is the only leg with a bill.
    readAllowance.mockImplementation(async () => quotedBaseUnits);
    readPermit2Allowance.mockImplementation(async () => ({
      amount: quotedBaseUnits,
      expiration: Math.floor(Date.now() / 1000) + 1_000,
    }));
    confirmTransfer.mockResolvedValue(
      billedReceipt(180_000n, transferLog(EURC, WALLET, 424_400_000n)),
    );

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    // 180,000 units at 25.2 gwei, billed in USDC out of the balance itself.
    expect(outcome.settlement.gasCostUsdc).toBe("0.004536");
    // The fill is the router's payout, so it is gross of that cost.
    expect(outcome.settlement.realisedOutput).toBe("424.4");
  });

  it("counts the allowance approval's gas, because the treasury paid for that too", async () => {
    confirmTransfer
      // The approval: 46,000 units at 25.2 gwei is 0.0011592 USDC, and the
      // fraction of a micro-USDC rounds up rather than being dropped.
      .mockResolvedValueOnce(billedReceipt(46_000n))
      .mockResolvedValueOnce(billedReceipt(180_000n, transferLog(EURC, WALLET, 424_400_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    expect(outcome.settlement.approvalTxHash).toBe(HASHES[0]);
    // 0.00116 approval plus 0.004536 swap: what the whole rebalance cost.
    expect(outcome.settlement.gasCostUsdc).toBe("0.005696");
  });

  it("reports the gas as not known when the receipt does not carry what it cost", async () => {
    readAllowance.mockImplementation(async () => quotedBaseUnits);
    confirmTransfer.mockResolvedValue(receipt(transferLog(EURC, WALLET, 424_400_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    // A cost that could not be read is not a rebalance that traded for free.
    expect(outcome.settlement.gasCostUsdc).toBeNull();
    expect(outcome.settlement.realisedOutput).toBe("424.4");
  });

  it("will not report a partial gas total when one leg's receipt is unreadable", async () => {
    confirmTransfer
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(billedReceipt(180_000n, transferLog(EURC, WALLET, 424_400_000n)));

    const outcome = await settleRebalance(TREASURY, TARGETS, QUOTE);

    expect(outcome.kind).toBe("settled");
    if (outcome.kind !== "settled") return;
    // The swap's own gas is readable, but the approval's is not, so the
    // rebalance's cost is unknown rather than understated by that leg.
    expect(outcome.settlement.gasCostUsdc).toBeNull();
  });

  it("never routes the untradable leg, even when it is the furthest from target", async () => {
    readCustodyHoldings.mockResolvedValue(holdings(1000, 0));

    await settleRebalance(TREASURY, TARGETS, QUOTE);

    const [request] = getSwapQuote.mock.calls[0] as [{ inputSymbol: string; outputSymbol: string }];
    expect(request.inputSymbol).toBe("USDC");
    expect(request.outputSymbol).toBe("EURC");
  });
});

/**
 * Recovering a fill from a receipt alone. This is the path a rebalance takes
 * when the settlement that started it died: there is no pre-trade balance
 * left to measure against, only the transaction itself.
 */
describe("readFillFromReceipt", () => {
  const TX = `0x${"ab".repeat(32)}` as `0x${string}`;

  it("recovers what the swap paid into the custody wallet", async () => {
    getConfirmedReceipt.mockResolvedValue(
      receipt(
        // The input leg leaving the wallet, then the output leg arriving.
        transferLog(USDC, POOL, 500_000_000n),
        transferLog(EURC, WALLET, 424_400_000n),
      ),
    );

    const fill = await readFillFromReceipt(TREASURY, TX);

    expect(fill?.token.symbol).toBe("EURC");
    expect(fill?.credited).toBe(424_400_000n);
    // Nothing to compare it against this late, and none is invented.
    expect(fill?.expectedOutput).toBeUndefined();
    expect(fill?.heldBefore).toBeUndefined();
  });

  it("reports nothing when the receipt cannot be read", async () => {
    getConfirmedReceipt.mockResolvedValue(null);

    expect(await readFillFromReceipt(TREASURY, TX)).toBeNull();
  });

  it("reports nothing when the swap credited the wallet in nothing at all", async () => {
    getConfirmedReceipt.mockResolvedValue(receipt(transferLog(EURC, POOL, 424_400_000n)));

    expect(await readFillFromReceipt(TREASURY, TX)).toBeNull();
  });

  it("refuses to guess when more than one token credited the wallet", async () => {
    getConfirmedReceipt.mockResolvedValue(
      receipt(
        transferLog(EURC, WALLET, 424_400_000n),
        transferLog(USDC, WALLET, 50_000_000n),
      ),
    );

    expect(await readFillFromReceipt(TREASURY, TX)).toBeNull();
  });

  it("never throws, whatever the chain does", async () => {
    getConfirmedReceipt.mockRejectedValue(new Error("socket hang up"));

    expect(await readFillFromReceipt(TREASURY, TX)).toBeNull();
  });
});
