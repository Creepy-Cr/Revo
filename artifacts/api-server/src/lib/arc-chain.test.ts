import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from "viem";

/**
 * Deposit verification reads the receipt straight from Arc. These tests
 * answer the JSON-RPC calls themselves, so the rule under test is the only
 * thing that can fail: a transaction the custody wallet sent is never a
 * deposit, however much USDC it happens to move back into custody.
 */
const TREASURY = "0x00000000000000000000000000000000000000aa";
const POOL_MANAGER = "0x00000000000000000000000000000000000000bb";
const DEPOSITOR = "0x00000000000000000000000000000000000000cc";
const USDC = "0x3600000000000000000000000000000000000000";
const TX = `0x${"ab".repeat(32)}` as Hex;

let receiptFrom = DEPOSITOR;
let transferFrom = DEPOSITOR;

function transferLog(from: string, to: string, value: bigint) {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from: from as Hex, to: to as Hex },
  });
  return {
    address: USDC,
    topics,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    blockNumber: "0x64",
    blockHash: `0x${"11".repeat(32)}`,
    transactionHash: TX,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

function receipt() {
  return {
    transactionHash: TX,
    transactionIndex: "0x0",
    blockHash: `0x${"11".repeat(32)}`,
    blockNumber: "0x64",
    from: receiptFrom,
    to: USDC,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    contractAddress: null,
    logs: [transferLog(transferFrom, TREASURY, 25_000_000n)],
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x2",
  };
}

beforeEach(() => {
  receiptFrom = DEPOSITOR;
  transferFrom = DEPOSITOR;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
      const result =
        body.method === "eth_chainId"
          ? "0x13b2"
          : body.method === "eth_getTransactionReceipt"
            ? receipt()
            : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyDeposit", () => {
  it("credits an external USDC transfer to its sender", async () => {
    const { verifyDeposit } = await import("./arc-chain");
    await expect(verifyDeposit(TX, TREASURY)).resolves.toEqual({
      from: DEPOSITOR,
      microUsdc: 25_000_000n,
    });
  });

  it("rejects a transaction the custody wallet itself sent, even when it moves USDC into custody", async () => {
    // A rebalance swap: sent by custody, output paid in by the pool manager.
    receiptFrom = TREASURY;
    transferFrom = POOL_MANAGER;
    const { verifyDeposit } = await import("./arc-chain");
    await expect(verifyDeposit(TX, TREASURY)).rejects.toMatchObject({
      code: "NOT_A_DEPOSIT",
      message: expect.stringMatching(/custody wallet/),
    });
  });
});
