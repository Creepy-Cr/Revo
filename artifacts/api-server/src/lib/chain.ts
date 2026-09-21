/**
 * Live Arc chain connectivity, per RPC provider.
 *
 * The console's chain badge and the health endpoint are backed by this
 * module: every configured provider is probed in parallel, the chain id of
 * each answer is verified, and the first healthy provider in failover order
 * supplies the headline numbers. Results are cached briefly; failures are
 * also cached (short TTL) so a flapping provider cannot be stampeded by
 * dashboard polling. On total failure the last good reading is served marked
 * stale with connected=false - chain data is never fabricated.
 */

import { ARC_CHAIN_ID, ARC_CHAIN_NAME } from "./arc-chain";
import { probeArcEndpoints, type EndpointProbe } from "./arc-rpc";

export const ARC_NETWORK = {
  network: ARC_CHAIN_NAME,
  chainId: ARC_CHAIN_ID,
} as const;

export interface ProviderStatus {
  label: string;
  reachable: boolean;
  chainId: number | null;
  blockNumber: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface ChainStatus {
  network: string;
  expectedChainId: number;
  connected: boolean;
  chainId?: number;
  blockNumber?: number;
  gasPriceWei?: string;
  latencyMs?: number;
  /** Every provider in failover order; present whenever a probe ran. */
  providers?: ProviderStatus[];
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

/** Test seam: forget cached readings. */
export function resetChainStatus(): void {
  lastGood = null;
  lastResult = null;
  lastProbeAt = 0;
  inFlight = null;
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
  // recovery cannot stampede the providers.
  if (inFlight) {
    return inFlight;
  }
  inFlight = probe(now).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

function toProviderStatus(probeResult: EndpointProbe): ProviderStatus {
  // A provider answering on another chain is reported as unreachable for
  // Revo's purposes: nothing may be read from it, whatever it says.
  const wrongChain = probeResult.reachable && probeResult.chainId !== ARC_CHAIN_ID;
  return {
    label: probeResult.label,
    reachable: probeResult.reachable && !wrongChain,
    chainId: probeResult.chainId,
    blockNumber: probeResult.blockNumber,
    latencyMs: probeResult.latencyMs,
    error: wrongChain
      ? `answered for chain ${probeResult.chainId}, expected Arc (${ARC_CHAIN_ID})`
      : probeResult.error,
  };
}

async function probe(now: number): Promise<ChainStatus> {
  lastProbeAt = now;
  const checkedAt = new Date().toISOString();
  let providers: ProviderStatus[] = [];
  let healthy: EndpointProbe | undefined;
  try {
    const probes = await probeArcEndpoints(RPC_TIMEOUT_MS);
    providers = probes.map(toProviderStatus);
    healthy = probes.find((p) => p.reachable && p.chainId === ARC_CHAIN_ID);
  } catch (error) {
    console.error("Arc RPC probe failed:", error);
  }

  if (healthy && healthy.blockNumber !== null && healthy.gasPriceWei !== null) {
    lastGood = {
      network: ARC_NETWORK.network,
      expectedChainId: ARC_NETWORK.chainId,
      connected: true,
      chainId: healthy.chainId ?? ARC_CHAIN_ID,
      blockNumber: healthy.blockNumber,
      gasPriceWei: healthy.gasPriceWei,
      latencyMs: healthy.latencyMs ?? 0,
      providers,
      stale: false,
      checkedAt,
    };
    lastResult = lastGood;
    return lastGood;
  }

  lastResult = lastGood
    ? { ...lastGood, connected: false, stale: true, providers, checkedAt }
    : {
        network: ARC_NETWORK.network,
        expectedChainId: ARC_NETWORK.chainId,
        connected: false,
        providers,
        stale: false,
        checkedAt,
      };
  console.error(
    "No Arc RPC provider answered for chain %d: %s",
    ARC_CHAIN_ID,
    providers.map((p) => `${p.label}=${p.error ?? "ok"}`).join(", "),
  );
  return lastResult;
}
