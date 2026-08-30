/**
 * On-chain whale-flow monitoring - LIVE, free, straight from Arc Testnet RPC.
 *
 * Scans recent blocks for large USDC ERC-20 Transfer events (USDC is Arc's
 * native asset exposed through an ERC-20 interface, 6 decimals). Everything
 * reported is a real observed on-chain event; when the RPC is unavailable
 * the whale signal is OMITTED - never fabricated, never served stale.
 *
 * Guards: chain-id verified on every refresh (locked to Arc Testnet),
 * single-flight dedup, 10min success cache, 5min failure cooldown, and a
 * smaller fallback block window if the RPC rejects the primary range.
 */

import { createPublicClient, http, parseAbiItem } from "viem";
import {
  ARC_RPC_URL,
  ARC_TESTNET_CHAIN_ID,
  USDC_ADDRESS,
  arcTestnet,
  fromMicroUsdc,
} from "./arc-chain";

const SUCCESS_TTL_MS = 10 * 60_000; // 10 minutes
const FAILURE_COOLDOWN_MS = 5 * 60_000; // 5 minutes
const PRIMARY_WINDOW_BLOCKS = 3000n;
const FALLBACK_WINDOW_BLOCKS = 500n;

/** A transfer at or above this many USDC counts as a whale move. */
export const WHALE_THRESHOLD_USDC = (() => {
  const raw = Number(process.env.WHALE_THRESHOLD_USDC ?? "10000");
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
})();

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 10_000 }),
});

export interface WhaleActivity {
  windowBlocks: number;
  /** Real elapsed time covered by the window, when block timestamps resolve. */
  windowMinutes: number | null;
  totalTransfers: number;
  whaleThresholdUsdc: number;
  whaleCount: number;
  whaleVolumeUsdc: number;
  largestUsdc: number;
  fetchedAt: number;
}

let cached: WhaleActivity | null = null;
let inFlight: Promise<WhaleActivity> | null = null;
let failureCooldownUntil = 0;

// If the RPC rejects the primary getLogs range, remember the working fallback
// window so refreshes stop wasting a doomed RPC call - and periodically
// re-probe the primary in case the provider's limits change.
let preferredWindow = PRIMARY_WINDOW_BLOCKS;
let primaryReprobeAt = 0;
const PRIMARY_REPROBE_MS = 60 * 60_000; // 1 hour

async function refreshWhaleActivity(): Promise<WhaleActivity> {
  // Locked to Arc Testnet - verified per refresh, never cached.
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(
      `RPC reports chain ${chainId}, expected Arc Testnet ${ARC_TESTNET_CHAIN_ID}`,
    );
  }

  const latest = await client.getBlockNumber();

  const scan = async (window: bigint) => {
    const fromBlock = latest > window ? latest - window : 0n;
    const logs = await client.getLogs({
      address: USDC_ADDRESS,
      event: transferEvent,
      fromBlock,
      toBlock: latest,
    });
    return { fromBlock, logs, window: Number(latest - fromBlock) };
  };

  let windowToUse = preferredWindow;
  if (preferredWindow !== PRIMARY_WINDOW_BLOCKS && Date.now() >= primaryReprobeAt) {
    windowToUse = PRIMARY_WINDOW_BLOCKS; // periodic re-probe of the big window
  }

  let result;
  try {
    result = await scan(windowToUse);
    preferredWindow = windowToUse;
  } catch (error) {
    if (windowToUse === FALLBACK_WINDOW_BLOCKS) throw error;
    // Some RPCs cap getLogs ranges - retry once with a small window and
    // stick with it for the next hour.
    result = await scan(FALLBACK_WINDOW_BLOCKS);
    preferredWindow = FALLBACK_WINDOW_BLOCKS;
    primaryReprobeAt = Date.now() + PRIMARY_REPROBE_MS;
  }

  const thresholdMicro = BigInt(Math.round(WHALE_THRESHOLD_USDC)) * 1_000_000n;
  let whaleCount = 0;
  let whaleVolumeMicro = 0n;
  let largestMicro = 0n;
  for (const log of result.logs) {
    const value = log.args.value ?? 0n;
    if (value > largestMicro) largestMicro = value;
    if (value >= thresholdMicro) {
      whaleCount += 1;
      whaleVolumeMicro += value;
    }
  }

  let windowMinutes: number | null = null;
  try {
    const [fromBlockData, latestBlockData] = await Promise.all([
      client.getBlock({ blockNumber: result.fromBlock }),
      client.getBlock({ blockNumber: latest }),
    ]);
    const seconds = Number(latestBlockData.timestamp - fromBlockData.timestamp);
    if (Number.isFinite(seconds) && seconds > 0) {
      windowMinutes = Math.round(seconds / 60);
    }
  } catch {
    windowMinutes = null; // cosmetic only - the scan itself already succeeded
  }

  const activity: WhaleActivity = {
    windowBlocks: result.window,
    windowMinutes,
    totalTransfers: result.logs.length,
    whaleThresholdUsdc: WHALE_THRESHOLD_USDC,
    whaleCount,
    whaleVolumeUsdc: fromMicroUsdc(whaleVolumeMicro),
    largestUsdc: fromMicroUsdc(largestMicro),
    fetchedAt: Date.now(),
  };
  cached = activity;
  failureCooldownUntil = 0;
  return activity;
}

export async function fetchWhaleActivity(): Promise<WhaleActivity | null> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < SUCCESS_TTL_MS) {
    return cached;
  }
  if (now < failureCooldownUntil) {
    return null; // cooling down - omit, never fabricate
  }

  if (!inFlight) {
    inFlight = refreshWhaleActivity().finally(() => {
      inFlight = null;
    });
  }
  try {
    return await inFlight;
  } catch (error) {
    console.error("Whale activity unavailable:", error);
    failureCooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    return null;
  }
}
