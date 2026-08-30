import { randomUUID } from "node:crypto";
import {
  db,
  onchainTransfersTable,
  treasuriesTable,
  treasuryStateTable,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import {
  ARC_RPC_URL,
  ARC_TESTNET_CHAIN_ID,
  USDC_ADDRESS,
  arcTestnet,
  ensureTreasuryWallet,
  fromMicroUsdc,
} from "../arc-chain";
import { auditSafe } from "../audit";
import { raiseAlert } from "../alerts";
import { treasuryTransitionLock } from "../security-controls";
import { loadState, logActivity } from "../state";
import { getCheckpoint, setCheckpoint, type WorkerJob } from "./index";

/**
 * Background deposit indexer: scans Arc Testnet USDC Transfer logs addressed
 * to the treasury wallet and credits them durably - so a deposit is never
 * lost just because the depositor's browser closed before the claim step.
 *
 * Safety properties:
 * - Chain id asserted on EVERY run (never cached) before anything is credited.
 * - Only blocks with >= 2 confirmations are scanned (reorg guard).
 * - Credit is idempotent: unique txHash insert + units credit commit together
 *   under the treasury-transition advisory lock - the same guarantee as the
 *   manual claim endpoint, so indexer and manual claims can never double-credit.
 * - The checkpoint only advances after a fully successful scan, so a crashed
 *   run re-scans instead of skipping.
 */

const JOB_NAME = "deposit-indexer";
const MAX_BLOCKS_PER_RUN = 900n;
/** Deep confirmation depth: a credit must never sit on a reorgable block. */
const CONFIRMATIONS = 12n;
/** First run scans this much recent history so deposits made while the
 *  service was down are still credited automatically. */
const BACKFILL_BLOCKS = 5000n;
/** How far to rewind when the checkpoint block's hash no longer matches the
 *  canonical chain (reorg). Rescans are safe: credits are idempotent. */
const REORG_REWIND_BLOCKS = 200n;

const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 10_000 }),
});

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function lockTreasuryTransitions(tx: Tx, treasuryId: string): Promise<void> {
  await tx.execute(treasuryTransitionLock(treasuryId));
}

interface IndexerCheckpoint {
  lastScannedBlock: string;
  /** Hash of lastScannedBlock, for reorg detection on the next run. */
  lastScannedHash?: string;
}

async function processTreasury(treasuryId: string): Promise<string | void> {
  // Treasury state must exist before credits can land; if it does not, skip
  // WITHOUT advancing the checkpoint so nothing is ever missed.
  try {
    await loadState(treasuryId);
  } catch {
    return "Treasury state unavailable; indexer idle";
  }

  const wallet = await ensureTreasuryWallet(treasuryId);
  const treasuryAddress = wallet.address.toLowerCase();

  // Chain-id guard: asserted per run, never cached.
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET_CHAIN_ID) {
    throw new Error(`RPC chain id ${chainId} is not Arc Testnet (${ARC_TESTNET_CHAIN_ID})`);
  }

  const latest = await client.getBlockNumber();
  const safeTip = latest - CONFIRMATIONS;
  if (safeTip <= 0n) return;

  const checkpoint = await getCheckpoint<IndexerCheckpoint>(JOB_NAME, treasuryId);
  if (!checkpoint?.lastScannedBlock) {
    // First run: start a bounded distance back so deposits made while the
    // service (or this feature) was down still get credited automatically.
    // The checkpoint stores the LAST SCANNED block, so subtract one more -
    // scanning resumes at checkpoint + 1.
    const start = safeTip > BACKFILL_BLOCKS ? safeTip - BACKFILL_BLOCKS - 1n : 0n;
    await setCheckpoint(JOB_NAME, treasuryId, { lastScannedBlock: start.toString() });
    return `Indexer initialized at block ${start} (backfilling to ${safeTip})`;
  }

  // Reorg guard: if the block we last scanned no longer has the hash we
  // recorded, the chain reorganized past our checkpoint. Rewind a bounded
  // window and rescan - idempotent credits make the rescan safe.
  if (checkpoint.lastScannedHash) {
    const anchor = await client
      .getBlock({ blockNumber: BigInt(checkpoint.lastScannedBlock) })
      .catch(() => null);
    if (anchor && anchor.hash.toLowerCase() !== checkpoint.lastScannedHash.toLowerCase()) {
      const last = BigInt(checkpoint.lastScannedBlock);
      const rewound = last > REORG_REWIND_BLOCKS ? last - REORG_REWIND_BLOCKS : 0n;
      await setCheckpoint(JOB_NAME, treasuryId, { lastScannedBlock: rewound.toString() });
      return `Reorg detected at block ${last}; rewound checkpoint to ${rewound}`;
    }
  }

  const from = BigInt(checkpoint.lastScannedBlock) + 1n;
  if (from > safeTip) return;
  const to = safeTip - from >= MAX_BLOCKS_PER_RUN ? from + MAX_BLOCKS_PER_RUN - 1n : safeTip;

  const logs = await client.getLogs({
    address: USDC_ADDRESS,
    event: transferEvent,
    args: { to: wallet.address as Address },
    fromBlock: from,
    toBlock: to,
  });

  let credited = 0;
  for (const log of logs) {
    const sender = (log.args.from ?? "").toLowerCase();
    const micro = log.args.value ?? 0n;
    const txHash = log.transactionHash.toLowerCase();
    if (!sender || micro <= 0n) continue;
    if (sender === treasuryAddress) continue; // treasury self-transfers are not deposits

    const amountUsdc = fromMicroUsdc(micro);
    const row = await db.transaction(async (tx) => {
      await lockTreasuryTransitions(tx, treasuryId);
      const [inserted] = await tx
        .insert(onchainTransfersTable)
        .values({
          id: `xfer-${randomUUID()}`,
          treasuryId,
          direction: "deposit",
          wallet: sender,
          amountUsdc,
          txHash,
          status: "confirmed",
          confirmedAt: new Date(),
        })
        .onConflictDoNothing({ target: onchainTransfersTable.txHash })
        .returning();
      if (!inserted) return null; // already credited (manual claim or earlier scan)

      await tx
        .update(treasuryStateTable)
        .set({
          usdcUnits: sql`${treasuryStateTable.usdcUnits} + ${amountUsdc}`,
          updatedAt: new Date(),
        })
        .where(eq(treasuryStateTable.id, treasuryId));
      return inserted;
    });

    if (row) {
      credited += 1;
      await logActivity(
        treasuryId,
        "On-chain deposit received",
        `${amountUsdc.toLocaleString("en-US", { maximumFractionDigits: 6 })} testnet USDC deposited from ${sender} (auto-indexed on Arc Testnet, tx ${txHash.slice(0, 10)}…). Credited to the liquid reserve.`,
        "executed",
      );
      await auditSafe({
        treasuryId,
        action: "wallet.deposit.indexed",
        actorWallet: null,
        resourceId: row.id,
        result: "ok",
        detail: { txHash, amountUsdc, from: sender, block: log.blockNumber?.toString() },
      });
    }
  }

  // Advance only after the whole window succeeded, anchoring the block hash
  // so the next run can detect a reorg past this point.
  const toBlock = await client.getBlock({ blockNumber: to }).catch(() => null);
  await setCheckpoint(JOB_NAME, treasuryId, {
    lastScannedBlock: to.toString(),
    ...(toBlock ? { lastScannedHash: toBlock.hash.toLowerCase() } : {}),
  });
  if (credited > 0) return `Credited ${credited} deposit(s) in blocks ${from}-${to}`;
}

async function runDepositIndexer(): Promise<string | void> {
  const treasuries = await db.select({ id: treasuriesTable.id }).from(treasuriesTable);
  const summaries: string[] = [];
  for (const treasury of treasuries) {
    try {
      const summary = await processTreasury(treasury.id);
      if (summary) summaries.push(`${treasury.id}: ${summary}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await raiseAlert({
        treasuryId: treasury.id,
        severity: "critical",
        kind: "worker.deposit-indexer.failed",
        title: "Deposit indexer failed",
        detail: message,
      }).catch(() => undefined);
    }
  }
  return summaries.length ? summaries.join("; ") : undefined;
}

export const depositIndexerJob: WorkerJob = {
  name: JOB_NAME,
  intervalMs: 30_000,
  run: runDepositIndexer,
};
