/**
 * Arc mainnet RPC access with provider failover.
 *
 * Arc mainnet is served by several public JSON-RPC providers. Revo treats
 * them as one pool: every request goes to the first endpoint in order and
 * falls through to the next on a transport error, a timeout or a provider
 * error such as a rejected log range. Execution reverts are NOT retried on
 * another provider, because a revert is a property of the chain, not of the
 * node that reported it.
 *
 * Provider differences measured on 21 September 2026 shape the defaults:
 * - Circle and QuickNode serve full history and accept `eth_getLogs` spans
 *   up to about 5,000 blocks.
 * - Blockdaemon accepts wider log spans but prunes history after a few days.
 * - dRPC rejects every `eth_getLogs` call on its free plan, so it is the last
 *   resort and only ever answers state reads and sends.
 * Anything reading logs therefore keeps its spans at or under
 * `MAX_LOG_SPAN_BLOCKS`, so that a fall-through to a stricter provider is
 * still a valid request.
 *
 * Every endpoint is tracked so the health endpoint can say which providers
 * are answering. The chain id is verified per operation elsewhere; this
 * module only decides where a request goes.
 */

import { custom, fallback, http, type Transport } from "viem";

export interface ArcRpcEndpoint {
  url: string;
  /** Hostname, used for logs and health output. Never the full URL, which may embed a key. */
  label: string;
}

export const DEFAULT_ARC_RPC_URLS: readonly string[] = [
  "https://rpc.mainnet.arc.io",
  "https://rpc.quicknode.mainnet.arc.io",
  "https://rpc.blockdaemon.mainnet.arc.io",
  "https://rpc.drpc.mainnet.arc.io",
];

/** Largest `eth_getLogs` block span every configured provider is known to accept. */
export const MAX_LOG_SPAN_BLOCKS = 4_000n;

function parseEndpoints(raw: string | undefined): ArcRpcEndpoint[] {
  const urls = (raw ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const source = urls.length > 0 ? urls : [...DEFAULT_ARC_RPC_URLS];
  const endpoints: ArcRpcEndpoint[] = [];
  for (const url of source) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`ARC_RPC_URLS contains an invalid URL: ${url.slice(0, 64)}`);
    }
    if (parsed.protocol !== "https:") {
      throw new Error(`ARC_RPC_URLS must use https, got ${parsed.protocol} for ${parsed.hostname}`);
    }
    endpoints.push({ url, label: parsed.hostname });
  }
  return endpoints;
}

let cachedEndpoints: ArcRpcEndpoint[] | null = null;

/**
 * The ordered provider list. `ARC_RPC_URLS` (comma-separated, https only)
 * overrides the public defaults; the first entry is the primary.
 */
export function arcRpcEndpoints(): ArcRpcEndpoint[] {
  cachedEndpoints ??= parseEndpoints(process.env["ARC_RPC_URLS"]);
  return cachedEndpoints;
}

/** Test seam: forget the parsed endpoint list and all health tracking. */
export function resetArcRpc(): void {
  cachedEndpoints = null;
  health.clear();
  chainVerification.clear();
}

export interface EndpointHealth {
  label: string;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastLatencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

const health = new Map<string, EndpointHealth>();

function healthFor(endpoint: ArcRpcEndpoint): EndpointHealth {
  let entry = health.get(endpoint.url);
  if (!entry) {
    entry = {
      label: endpoint.label,
      lastOkAt: null,
      lastErrorAt: null,
      lastLatencyMs: null,
      consecutiveFailures: 0,
      lastError: null,
    };
    health.set(endpoint.url, entry);
  }
  return entry;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Provider errors can echo the request, which for a send is the signed payload.
  return message.replace(/0x[0-9a-fA-F]{128,}/g, "[redacted]").slice(0, 200);
}

/** Passive health snapshot: what each provider did the last time it was asked. */
export function arcRpcHealth(): EndpointHealth[] {
  return arcRpcEndpoints().map((endpoint) => ({ ...healthFor(endpoint) }));
}

/** Whether an error is a revert, which no other provider will answer differently. */
function isRevert(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution reverted|revert/i.test(message);
}

/** Arc mainnet. Every endpoint must prove it serves this chain before it serves anything else. */
export const ARC_MAINNET_CHAIN_ID = 5042;
const CHAIN_VERIFICATION_TTL_MS = 5 * 60_000;

/**
 * Per-endpoint chain verification. An endpoint that answers `eth_chainId`
 * with anything but Arc mainnet is rejected for the life of the process: the
 * fallback moves past it and it never serves a read or a send. A verification
 * that merely fails to get an answer is not a rejection and is retried.
 */
const chainVerification = new Map<string, { verifiedAt: number } | { rejectedChainId: string }>();

export class WrongChainEndpointError extends Error {
  constructor(label: string, chainId: string) {
    super(`RPC endpoint ${label} serves chain ${chainId}, not Arc mainnet (${ARC_MAINNET_CHAIN_ID}); it is disabled.`);
    this.name = "WrongChainEndpointError";
  }
}

async function assertEndpointIsArc(
  endpoint: ArcRpcEndpoint,
  request: (args: { method: string; params?: unknown }) => Promise<unknown>,
): Promise<void> {
  const state = chainVerification.get(endpoint.url);
  if (state && "rejectedChainId" in state) {
    throw new WrongChainEndpointError(endpoint.label, state.rejectedChainId);
  }
  if (state && Date.now() - state.verifiedAt < CHAIN_VERIFICATION_TTL_MS) return;
  const answer = await request({ method: "eth_chainId" });
  const chainId = typeof answer === "string" ? answer.toLowerCase() : String(answer);
  if (chainId !== `0x${ARC_MAINNET_CHAIN_ID.toString(16)}`) {
    chainVerification.set(endpoint.url, { rejectedChainId: chainId });
    healthFor(endpoint).lastError = `serves chain ${chainId}, not Arc mainnet`;
    throw new WrongChainEndpointError(endpoint.label, chainId);
  }
  chainVerification.set(endpoint.url, { verifiedAt: Date.now() });
}

function tracked(endpoint: ArcRpcEndpoint, timeout: number): Transport {
  const inner = http(endpoint.url, { timeout, retryCount: 0, name: endpoint.label });
  return (params) => {
    const transport = inner(params);
    const rawRequest = (args: { method: string; params?: unknown }) =>
      transport.request(args as never) as Promise<unknown>;
    return custom(
      {
        async request(args: { method: string; params?: unknown }) {
          const entry = healthFor(endpoint);
          const started = Date.now();
          try {
            // The chain check rides the same endpoint as the request it
            // guards, so a fail-over can never hand a read or a signed send
            // to a node that was not itself verified.
            if (args.method !== "eth_chainId") await assertEndpointIsArc(endpoint, rawRequest);
            const result: unknown = await rawRequest(args);
            entry.lastOkAt = new Date().toISOString();
            entry.lastLatencyMs = Date.now() - started;
            entry.consecutiveFailures = 0;
            entry.lastError = null;
            return result;
          } catch (error) {
            // A revert is the chain answering, not the provider failing.
            if (!isRevert(error) && !(error instanceof WrongChainEndpointError)) {
              entry.lastErrorAt = new Date().toISOString();
              entry.consecutiveFailures += 1;
              entry.lastError = describeError(error);
            }
            throw error;
          }
        },
      },
      { key: `arc:${endpoint.label}`, name: endpoint.label, retryCount: 0 },
    )(params);
  };
}

/**
 * One transport over every configured provider, in order, with fall-through.
 * `rank` is off on purpose: the order encodes provider capability (history
 * depth, log support), which latency ranking would scramble.
 */
export function arcTransport(options: { timeout?: number } = {}): Transport {
  const timeout = options.timeout ?? 15_000;
  const transports = arcRpcEndpoints().map((endpoint) => tracked(endpoint, timeout));
  return fallback(transports, { rank: false, retryCount: 1, retryDelay: 250 });
}

export interface EndpointProbe {
  label: string;
  reachable: boolean;
  chainId: number | null;
  blockNumber: number | null;
  gasPriceWei: string | null;
  latencyMs: number | null;
  error: string | null;
}

/**
 * Active probe of one endpoint: chain id, head block and gas price in one
 * batched request. Used by the chain status route and the health endpoint;
 * it never throws, an unreachable provider is a row saying so.
 */
export async function probeArcEndpoint(
  endpoint: ArcRpcEndpoint,
  timeoutMs = 6_000,
): Promise<EndpointProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
        { jsonrpc: "2.0", id: 2, method: "eth_blockNumber", params: [] },
        { jsonrpc: "2.0", id: 3, method: "eth_gasPrice", params: [] },
      ]),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = (await response.json()) as Array<{ id: number; result?: string; error?: { message?: string } }>;
    if (!Array.isArray(body)) throw new Error("provider did not answer the batch");
    const byId = new Map(body.map((item) => [item.id, item]));
    const read = (id: number): string => {
      const item = byId.get(id);
      if (!item || typeof item.result !== "string") {
        throw new Error(item?.error?.message ?? `missing result ${id}`);
      }
      return item.result;
    };
    const chainId = Number.parseInt(read(1), 16);
    const blockNumber = Number.parseInt(read(2), 16);
    const gasPriceWei = BigInt(read(3)).toString();
    if (!Number.isFinite(chainId) || !Number.isFinite(blockNumber)) {
      throw new Error("provider returned a malformed number");
    }
    return {
      label: endpoint.label,
      reachable: true,
      chainId,
      blockNumber,
      gasPriceWei,
      latencyMs: Date.now() - started,
      error: null,
    };
  } catch (error) {
    return {
      label: endpoint.label,
      reachable: false,
      chainId: null,
      blockNumber: null,
      gasPriceWei: null,
      latencyMs: null,
      error: describeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probes every configured provider in parallel. */
export function probeArcEndpoints(timeoutMs?: number): Promise<EndpointProbe[]> {
  return Promise.all(arcRpcEndpoints().map((endpoint) => probeArcEndpoint(endpoint, timeoutMs)));
}
