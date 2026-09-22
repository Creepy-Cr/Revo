import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { encodeFunctionData, parseAbi, type Address, type PublicClient } from "viem";
import { auditEventsTable, db } from "@workspace/db";
import { recordAudit } from "./audit";
import { ARC_TOKENS } from "./arc-tokens";
import { PERMIT2, UNIVERSAL_ROUTER, ZERO_ADDRESS, encodeV4Swap } from "./v4-calldata";
import { assertCustodyCallAllowed, ChainError } from "./arc-chain";
import {
  MAX_MARKET_QUOTE_AGE_MS,
  MAX_REBALANCE_USD_PER_DAY,
  MAX_REBALANCE_USD_PER_TRADE,
  REBALANCE_SIGNED_AUDIT_ACTION,
  assertFreshMarketQuote,
  assertRebalanceCaps,
  isBlockedByIssuer,
  rebalanceCapReason,
} from "./custody-policy";

const tokenAbi = parseAbi([
  "function transfer(address to,uint256 amount)",
  "function approve(address spender,uint256 amount)",
]);
const permit2Abi = parseAbi([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
const routerAbi = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline)"]);
const DESTINATION = "0x1111111111111111111111111111111111111111" as Address;

describe("custody signer allowlist", () => {
  const transfer = encodeFunctionData({
    abi: tokenAbi,
    functionName: "transfer",
    args: [DESTINATION, 1n],
  });
  const tokenApprove = encodeFunctionData({
    abi: tokenAbi,
    functionName: "approve",
    args: [PERMIT2, 1n],
  });
  const permitApprove = encodeFunctionData({
    abi: permit2Abi,
    functionName: "approve",
    args: [ARC_TOKENS.USDC.address, UNIVERSAL_ROUTER, 1n, 1],
  });
  const emptyExecute = encodeFunctionData({
    abi: routerAbi,
    functionName: "execute",
    args: ["0x", [], 1n],
  });
  const eurcForUsdc = encodeV4Swap({
    key: {
      currency0: ARC_TOKENS.USDC.address,
      currency1: ARC_TOKENS.EURC.address,
      fee: 500,
      tickSpacing: 10,
      hooks: ZERO_ADDRESS,
    },
    input: ARC_TOKENS.EURC.address,
    output: ARC_TOKENS.USDC.address,
    amountIn: 1_000_000n,
    minOut: 1_100_000n,
    deadline: 1n,
  });

  it("accepts each legal target and selector pair", () => {
    expect(() => assertCustodyCallAllowed(ARC_TOKENS.USDC.address, transfer)).not.toThrow();
    expect(() => assertCustodyCallAllowed(ARC_TOKENS.EURC.address, tokenApprove)).not.toThrow();
    expect(() => assertCustodyCallAllowed(PERMIT2, permitApprove)).not.toThrow();
    expect(() => assertCustodyCallAllowed(UNIVERSAL_ROUTER, eurcForUsdc)).not.toThrow();
  });

  it("refuses router calldata that is not one pinned swap, whatever the selector", () => {
    // The selector alone used to be enough. An empty command list is a legal
    // execute() call and does nothing, and it must still be refused: the
    // signer only signs the one payload shape it can prove.
    expect(() => assertCustodyCallAllowed(UNIVERSAL_ROUTER, emptyExecute)).toThrow(/single V4_SWAP/);
  });

  it("never approves a held-only token for spending, on the token or through Permit2", () => {
    const wars = ARC_TOKENS.wARS;
    expect(wars.tradable).toBe(false);
    expect(() => assertCustodyCallAllowed(wars.address, tokenApprove)).toThrow(/never traded/);
    const permitWars = encodeFunctionData({
      abi: permit2Abi,
      functionName: "approve",
      args: [wars.address, UNIVERSAL_ROUTER, 1n, 1],
    });
    expect(() => assertCustodyCallAllowed(PERMIT2, permitWars)).toThrow(/never traded/);
    // Transfers stay open so the position can always be withdrawn.
    expect(() => assertCustodyCallAllowed(wars.address, transfer)).not.toThrow();
  });

  it("rejects foreign targets, selectors, value, and approval spenders", () => {
    expect(() => assertCustodyCallAllowed(DESTINATION, transfer)).toThrow(ChainError);
    expect(() => assertCustodyCallAllowed(ARC_TOKENS.USDC.address, "0x12345678")).toThrow(
      ChainError,
    );
    expect(() => assertCustodyCallAllowed(ARC_TOKENS.USDC.address, transfer, 1n)).toThrow(
      ChainError,
    );
    const foreignApprove = encodeFunctionData({
      abi: tokenAbi,
      functionName: "approve",
      args: [DESTINATION, 1n],
    });
    expect(() => assertCustodyCallAllowed(ARC_TOKENS.USDC.address, foreignApprove)).toThrow(
      ChainError,
    );
  });
});

describe("custody market and issuer policy", () => {
  it("allows exact cap boundaries and refuses amounts above them", () => {
    expect(rebalanceCapReason(MAX_REBALANCE_USD_PER_TRADE, 0)).toBeNull();
    expect(rebalanceCapReason(MAX_REBALANCE_USD_PER_TRADE + 0.01, 0)).toMatch(
      /per-trade/,
    );
    expect(
      rebalanceCapReason(
        MAX_REBALANCE_USD_PER_TRADE,
        MAX_REBALANCE_USD_PER_DAY - MAX_REBALANCE_USD_PER_TRADE,
      ),
    ).toBeNull();
    expect(
      rebalanceCapReason(
        MAX_REBALANCE_USD_PER_TRADE,
        MAX_REBALANCE_USD_PER_DAY - MAX_REBALANCE_USD_PER_TRADE + 0.01,
      ),
    ).toMatch(/24h/);
  });

  it("refuses stale and over-age independent prices", () => {
    expect(() => assertFreshMarketQuote({ stale: true, fetchedAt: Date.now() })).toThrow(
      /stale/,
    );
    expect(() =>
      assertFreshMarketQuote({
        stale: false,
        fetchedAt: Date.now() - MAX_MARKET_QUOTE_AGE_MS - 1,
      }),
    ).toThrow(/10 minutes/);
    expect(() =>
      assertFreshMarketQuote({
        stale: false,
        fetchedAt: Date.now() - MAX_MARKET_QUOTE_AGE_MS,
      }),
    ).not.toThrow();
  });

  it("reads paused and blacklist controls without caching", async () => {
    const readContract = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const status = await isBlockedByIssuer(
      ARC_TOKENS.USDC.address,
      DESTINATION,
      UNIVERSAL_ROUTER,
      { readContract } as unknown as PublicClient,
    );
    expect(status).toEqual({
      tokenPaused: true,
      walletBlacklisted: true,
      destinationBlacklisted: false,
    });
    expect(readContract).toHaveBeenCalledTimes(3);
  });
});

describe("issuer controls follow the registry", () => {
  it("probes only the controls the contract exposes, and none for a token with none", async () => {
    // wARS blocks through isBlocked, not isBlacklisted; syrupUSDC exposes
    // neither a pause nor a blocklist, so nothing is called at all.
    const wars = vi.fn(async (req: { functionName: string }) => req.functionName === "isBlocked");
    const status = await isBlockedByIssuer(ARC_TOKENS.wARS.address, DESTINATION, UNIVERSAL_ROUTER, {
      readContract: wars,
    } as unknown as PublicClient);
    expect(status).toEqual({ tokenPaused: false, walletBlacklisted: true, destinationBlacklisted: true });
    expect(wars.mock.calls.map((c) => (c[0] as { functionName: string }).functionName).sort()).toEqual([
      "isBlocked",
      "isBlocked",
      "paused",
    ]);

    const syrup = vi.fn();
    const clear = await isBlockedByIssuer(ARC_TOKENS.syrupUSDC.address, DESTINATION, UNIVERSAL_ROUTER, {
      readContract: syrup,
    } as unknown as PublicClient);
    expect(clear).toEqual({ tokenPaused: false, walletBlacklisted: false, destinationBlacklisted: false });
    expect(syrup).not.toHaveBeenCalled();
  });

  it("refuses a token that is not pinned rather than guessing its controls", async () => {
    const readContract = vi.fn();
    await expect(
      isBlockedByIssuer("0x000000000000000000000000000000000000dead", DESTINATION, undefined, {
        readContract,
      } as unknown as PublicClient),
    ).rejects.toMatchObject({ name: "ChainError", code: "REFUSED_BY_POLICY" });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("checks freshness per reference price when the leg's price ids are given", () => {
    const fresh = { stale: false, fetchedAt: Date.now() };
    const quote = {
      ...fresh,
      stale: true,
      prices: {
        "coingecko:usd-coin": fresh,
        "fx:ARS": { stale: true, fetchedAt: Date.now() },
      },
    };
    // The whole feed is flagged stale because the FX leg is, but a trade
    // that only depends on the anchor is still allowed to proceed.
    expect(() => assertFreshMarketQuote(quote)).toThrow(/stale/);
    expect(() => assertFreshMarketQuote(quote, ["coingecko:usd-coin"])).not.toThrow();
    expect(() => assertFreshMarketQuote(quote, ["coingecko:usd-coin", "fx:ARS"])).toThrow(/fx:ARS/);
    expect(() => assertFreshMarketQuote(quote, ["coingecko:bitcoin"])).toThrow(/No independent market price/);
  });
});

describe("custody issuer reads that fail", () => {
  it("reports an unreadable control as an RPC failure, never as a verdict", async () => {
    const readContract = vi.fn().mockRejectedValue(new Error("HTTP request failed"));
    await expect(
      isBlockedByIssuer(ARC_TOKENS.USDC.address, DESTINATION, UNIVERSAL_ROUTER, {
        readContract,
      } as unknown as PublicClient),
    ).rejects.toMatchObject({ name: "ChainError", code: "RPC_UNAVAILABLE" });
  });
});

describe("cap configuration", () => {
  const load = async (perTrade: string | undefined, perDay: string | undefined) => {
    vi.resetModules();
    if (perTrade === undefined) delete process.env["REBALANCE_MAX_USD_PER_TRADE"];
    else process.env["REBALANCE_MAX_USD_PER_TRADE"] = perTrade;
    if (perDay === undefined) delete process.env["REBALANCE_MAX_USD_PER_DAY"];
    else process.env["REBALANCE_MAX_USD_PER_DAY"] = perDay;
    try {
      return await import("./custody-policy");
    } finally {
      delete process.env["REBALANCE_MAX_USD_PER_TRADE"];
      delete process.env["REBALANCE_MAX_USD_PER_DAY"];
    }
  };

  it("refuses to start on a cap that would switch the limits off", async () => {
    await expect(load("bad", undefined)).rejects.toThrow(/REBALANCE_MAX_USD_PER_TRADE/);
    await expect(load(undefined, "Infinity")).rejects.toThrow(/REBALANCE_MAX_USD_PER_DAY/);
    await expect(load("0", undefined)).rejects.toThrow(/REBALANCE_MAX_USD_PER_TRADE/);
    await expect(load("50000", "10000")).rejects.toThrow(/at least REBALANCE_MAX_USD_PER_TRADE/);
  });

  it("accepts explicit finite caps and falls back to the defaults when unset", async () => {
    const custom = await load("1000", "5000");
    expect(custom.MAX_REBALANCE_USD_PER_TRADE).toBe(1000);
    expect(custom.MAX_REBALANCE_USD_PER_DAY).toBe(5000);
    const defaults = await load(undefined, "");
    expect(defaults.MAX_REBALANCE_USD_PER_TRADE).toBe(25_000);
    expect(defaults.MAX_REBALANCE_USD_PER_DAY).toBe(100_000);
  });
});

describe("rolling 24h rebalance cap", () => {
  const treasuryId = `test-custody-caps-${randomUUID()}`;

  afterAll(async () => {
    await db.delete(auditEventsTable).where(eq(auditEventsTable.treasuryId, treasuryId));
  });

  it("counts every swap that reached signing, whether or not it confirmed", async () => {
    // Signed and claimed, receipt never learned: it still committed value.
    await recordAudit({
      treasuryId,
      action: REBALANCE_SIGNED_AUDIT_ACTION,
      actorRole: "system",
      result: "ok",
      detail: { tradeUsd: MAX_REBALANCE_USD_PER_DAY - 10_000 },
    });
    // A confirmation row must not double count the same trade.
    await recordAudit({
      treasuryId,
      action: "custody.rebalance.executed",
      actorRole: "system",
      result: "ok",
      detail: { tradeUsd: MAX_REBALANCE_USD_PER_DAY - 10_000 },
    });
    await expect(assertRebalanceCaps(treasuryId, 10_000)).resolves.toBeUndefined();
    await expect(assertRebalanceCaps(treasuryId, 10_000.01)).rejects.toMatchObject({
      code: "REFUSED_BY_POLICY",
    });
    await expect(assertRebalanceCaps(treasuryId, MAX_REBALANCE_USD_PER_TRADE + 1)).rejects.toMatchObject({
      code: "REFUSED_BY_POLICY",
    });
  });
});
