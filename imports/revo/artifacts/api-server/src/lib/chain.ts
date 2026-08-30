/**
 * Live Arc Testnet chain connectivity via public JSON-RPC.
 *
 * The console's "Arc Testnet" badge is backed by this module: we probe the
 * public RPC endpoint, verify the chain ID, and surface the latest block.
 * Results are cached briefly; failures are also cached (short TTL) so a
 * flapping RPC cannot stampede the upstream from dashboard polling. On
 * failure we serve the last good reading marked stale with connected=false -
 * we never fabricate chain data.
 */

export const ARC_TESTNET = {
  network: "Arc Testnet",
  chainId: 5042002,
  rpcUrl: process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network",
} as const;

export interface ChainStatus {
  network: string;
  expectedChainId: number;
  connected: boolean;
  chainId?: number;
  blockNumber?: number;
  gasPriceWei?: string;
  latencyMs?: number;
  stale: boolean;
  checkedAt: string;
}

const SUCCESS_TTL_MS = 15_000;
const FAILURE_TTL_MS = 5_000;
const RPC_TIMEOUT_MS = 6_000;

let lastGood: ChainStatus | null = null;
let lastResult: ChainStatus | null = null;
let lastProbeAt = 0;
let inFlight: Promise<ChainStatus> | null = null;

interface RpcCall {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
}

async function rpcBatch(methods: string[]): Promise<string[]> {
  const body: RpcCall[] = methods.map((method, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method,
    params: [],
  }));
  const res = await fetch(ARC_TESTNET.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Arc RPC responded ${res.status}`);
  }
  const json = (await res.json()) as Array<{
    id: number;
    result?: string;
    error?: { message?: string };
  }>;
  if (!Array.isArray(json) || json.length !== methods.length) {
    throw new Error("Arc RPC returned a malformed batch response");
  }
  const byId = new Map(json.map((entry) => [entry.id, entry]));
  return methods.map((_, i) => {
    const entry = byId.get(i + 1);
    if (!entry || typeof entry.result !== "string") {
      throw new Error(entry?.error?.message ?? "Arc RPC batch entry missing result");
    }
    return entry.result;
  });
}

export async function getChainStatus(): Promise<ChainStatus> {
  const now = Date.now();
  if (lastResult) {
    const ttl = lastResult.connected ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (now - lastProbeAt < ttl) {
      return lastResult;
    }
  }

  // Coalesce concurrent callers onto one probe so a cold start or outage
  // recovery cannot stampede the RPC endpoint.
  if (inFlight) {
    return inFlight;
  }
  inFlight = probe(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function probe(now: number): Promise<ChainStatus> {
  lastProbeAt = now;
  try {
    const started = Date.now();
    const [chainIdHex, blockHex, gasHex] = await rpcBatch([
      "eth_chainId",
      "eth_blockNumber",
      "eth_gasPrice",
    ]);
    const latencyMs = Date.now() - started;
    const chainId = Number.parseInt(chainIdHex ?? "", 16);
    const blockNumber = Number.parseInt(blockHex ?? "", 16);
    const gasPriceWei = BigInt(gasHex ?? "0x0").toString();

    if (!Number.isFinite(chainId) || !Number.isFinite(blockNumber)) {
      throw new Error("Arc RPC returned non-numeric chain data");
    }
    if (chainId !== ARC_TESTNET.chainId) {
      throw new Error(
        `RPC endpoint is on chain ${chainId}, expected Arc Testnet ${ARC_TESTNET.chainId}`,
      );
    }

    lastGood = {
      network: ARC_TESTNET.network,
      expectedChainId: ARC_TESTNET.chainId,
      connected: true,
      chainId,
      blockNumber,
      gasPriceWei,
      latencyMs,
      stale: false,
      checkedAt: new Date().toISOString(),
    };
    lastResult = lastGood;
    return lastGood;
  } catch (error) {
    const checkedAt = new Date().toISOString();
    lastResult = lastGood
      ? { ...lastGood, connected: false, stale: true, checkedAt }
      : {
          network: ARC_TESTNET.network,
          expectedChainId: ARC_TESTNET.chainId,
          connected: false,
          stale: false,
          checkedAt,
        };
    console.error("Arc Testnet RPC probe failed:", error);
    return lastResult;
  }
}
