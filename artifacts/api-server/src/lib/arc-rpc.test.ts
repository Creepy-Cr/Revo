import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicClient } from "viem";

/**
 * The provider fail-over must never hand a request to a node that serves a
 * different chain. Each endpoint is verified over its own connection before
 * it serves anything, and a wrong answer disables it for good.
 */
const GOOD = "https://good.example";
const WRONG = "https://wrong.example";
const DOWN = "https://down.example";

type Call = { url: string; method: string };
const calls: Call[] = [];

function jsonRpc(id: unknown, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function answer(url: string, method: string): unknown {
  if (url.startsWith(WRONG)) {
    if (method === "eth_chainId") return "0x1";
    return "0xdead";
  }
  if (method === "eth_chainId") return "0x13b2";
  if (method === "eth_blockNumber") return "0x64";
  return "0x0";
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body)) as { id: unknown; method: string };
      calls.push({ url, method: body.method });
      if (url.startsWith(DOWN)) throw new TypeError("fetch failed");
      return jsonRpc(body.id, answer(url, body.method));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env["ARC_RPC_URLS"];
});

async function loadTransport(urls: string[]) {
  process.env["ARC_RPC_URLS"] = urls.join(",");
  const mod = await import("./arc-rpc");
  mod.resetArcRpc();
  return mod;
}

describe("arcTransport chain guard", () => {
  it("verifies every endpoint on its own connection and skips one serving another chain", async () => {
    const { arcTransport } = await loadTransport([WRONG, GOOD]);
    const client = createPublicClient({ transport: arcTransport(), cacheTime: 0 });

    await expect(client.getBlockNumber()).resolves.toBe(100n);

    const wrongCalls = calls.filter((c) => c.url.startsWith(WRONG)).map((c) => c.method);
    expect(wrongCalls).toEqual(["eth_chainId"]);
    const goodCalls = calls.filter((c) => c.url.startsWith(GOOD)).map((c) => c.method);
    expect(goodCalls).toEqual(["eth_chainId", "eth_blockNumber"]);
  });

  it("never asks a rejected endpoint again, and reports it in health", async () => {
    const { arcTransport, arcRpcHealth } = await loadTransport([WRONG, GOOD]);
    const client = createPublicClient({ transport: arcTransport(), cacheTime: 0 });

    await client.getBlockNumber();
    calls.length = 0;
    await client.getBlockNumber();

    expect(calls.filter((c) => c.url.startsWith(WRONG))).toHaveLength(0);
    // The verified endpoint is not re-verified on every call.
    expect(calls.map((c) => c.method)).toEqual(["eth_blockNumber"]);
    const wrong = arcRpcHealth().find((h) => h.label === "wrong.example");
    expect(wrong?.lastError).toMatch(/serves chain 0x1, not Arc mainnet/);
  });

  it("fails the request rather than falling back to a wrong-chain node when no good node is left", async () => {
    const { arcTransport } = await loadTransport([DOWN, WRONG]);
    const client = createPublicClient({ transport: arcTransport(), cacheTime: 0 });

    await expect(client.getBlockNumber()).rejects.toThrow();
    expect(calls.filter((c) => c.url.startsWith(WRONG) && c.method !== "eth_chainId")).toHaveLength(0);
  });

  it("does not treat a failed verification as a rejection", async () => {
    const { arcTransport } = await loadTransport([DOWN, GOOD]);
    const client = createPublicClient({ transport: arcTransport(), cacheTime: 0 });

    await expect(client.getBlockNumber()).resolves.toBe(100n);
    // The unreachable endpoint is asked again next time; it was never proven wrong.
    calls.length = 0;
    await client.getBlockNumber();
    expect(calls.some((c) => c.url.startsWith(DOWN) && c.method === "eth_chainId")).toBe(true);
  });
});
