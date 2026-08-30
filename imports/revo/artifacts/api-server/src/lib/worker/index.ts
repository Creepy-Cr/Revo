import { randomUUID } from "node:crypto";
import { db, workerStateTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../logger";
import { FOUNDING_TREASURY_ID } from "../auth";
import { depositIndexerJob } from "./deposit-indexer";
import { drawdownMonitorJob } from "./drawdown-monitor";
import { withdrawalReconcilerJob } from "./withdrawal-reconciler";

/**
 * Durable background worker.
 *
 * - Leadership is a lease row in worker_leases (works with pooled
 *   connections, unlike session-level advisory locks): the leader renews the
 *   lease every tick; another instance can take over only after it expires.
 * - Each job persists lastRun/lastSuccess/lastError plus a jsonb checkpoint
 *   in worker_state, so work resumes exactly where it left off across
 *   restarts and deploys.
 * - Jobs run sequentially inside a tick; every job failure is contained,
 *   recorded, and never takes the loop down.
 */

export interface WorkerJob {
  name: string;
  intervalMs: number;
  /** Returns an optional one-line summary for the log. */
  run: () => Promise<string | void>;
}

const LEASE_ID = "main-worker";
const LEASE_TTL_MS = 45_000;
const TICK_MS = 15_000;

const JOBS: WorkerJob[] = [withdrawalReconcilerJob, depositIndexerJob, drawdownMonitorJob];

const instanceId = randomUUID();
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let stopped = false;
const nextDueAt = new Map<string, number>();

async function tryHoldLease(): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LEASE_TTL_MS);
  const result = await db.execute(sql`
    INSERT INTO worker_leases (id, instance_id, expires_at, renewed_at)
    VALUES (${LEASE_ID}, ${instanceId}, ${expiresAt}, ${now})
    ON CONFLICT (id) DO UPDATE
      SET instance_id = EXCLUDED.instance_id,
          expires_at = EXCLUDED.expires_at,
          renewed_at = EXCLUDED.renewed_at
      WHERE worker_leases.instance_id = EXCLUDED.instance_id
         OR worker_leases.expires_at < now()
    RETURNING instance_id
  `);
  return result.rows.length > 0;
}

async function releaseLease(): Promise<void> {
  await db.execute(
    sql`DELETE FROM worker_leases WHERE id = ${LEASE_ID} AND instance_id = ${instanceId}`,
  );
}

async function recordJobRun(name: string, error: string | null): Promise<void> {
  const now = new Date();
  await db
    .insert(workerStateTable)
    .values({
      id: name,
      lastRunAt: now,
      lastSuccessAt: error === null ? now : null,
      lastError: error,
    })
    .onConflictDoUpdate({
      target: workerStateTable.id,
      set:
        error === null
          ? { lastRunAt: now, lastSuccessAt: now, lastError: null, updatedAt: now }
          : { lastRunAt: now, lastError: error, updatedAt: now },
    });
}

/** Read a job's persisted jsonb checkpoint. */
function checkpointId(jobName: string, treasuryId: string): string {
  return `${jobName}:${treasuryId}`;
}

export async function getCheckpoint<T>(
  jobName: string,
  treasuryId: string,
): Promise<T | null> {
  const id = checkpointId(jobName, treasuryId);
  const [row] = await db
    .select()
    .from(workerStateTable)
    .where(eq(workerStateTable.id, id));
  if (row) return (row.checkpoint as T | undefined) ?? null;

  // One-time compatibility bridge: the founding treasury inherits the old
  // unsuffixed checkpoint, but only when its scoped row does not yet exist.
  if (treasuryId === FOUNDING_TREASURY_ID) {
    const [legacy] = await db
      .select()
      .from(workerStateTable)
      .where(eq(workerStateTable.id, jobName));
    if (legacy) {
      await db
        .insert(workerStateTable)
        .values({ id, checkpoint: legacy.checkpoint })
        .onConflictDoNothing({ target: workerStateTable.id });
      const [seeded] = await db
        .select()
        .from(workerStateTable)
        .where(eq(workerStateTable.id, id));
      return (seeded?.checkpoint as T | undefined) ?? null;
    }
  }
  return null;
}

/** Persist a job's jsonb checkpoint without touching run bookkeeping. */
export async function setCheckpoint(
  jobName: string,
  treasuryId: string,
  checkpoint: unknown,
): Promise<void> {
  await db
    .insert(workerStateTable)
    .values({ id: checkpointId(jobName, treasuryId), checkpoint })
    .onConflictDoUpdate({
      target: workerStateTable.id,
      set: { checkpoint, updatedAt: new Date() },
    });
}

async function tick(): Promise<void> {
  if (ticking || stopped) return;
  ticking = true;
  try {
    const leader = await tryHoldLease();
    if (!leader) return;

    for (const job of JOBS) {
      if (stopped) return;
      const due = nextDueAt.get(job.name) ?? 0;
      if (Date.now() < due) continue;
      // Renew the lease before every job so a long-running predecessor can't
      // outlive its lease while another instance starts the same job.
      if (!(await tryHoldLease())) return;
      nextDueAt.set(job.name, Date.now() + job.intervalMs);
      try {
        const summary = await job.run();
        await recordJobRun(job.name, null);
        if (summary) logger.info({ job: job.name }, summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ job: job.name, err: error }, "Worker job failed");
        await recordJobRun(job.name, message).catch(() => undefined);
      }
    }
  } catch (error) {
    logger.warn({ err: error }, "Worker tick failed");
  } finally {
    ticking = false;
  }
}

export function startWorker(): void {
  if (timer) return;
  stopped = false;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  // First tick immediately so recovery work (stuck withdrawals, missed
  // deposits) does not wait for the first interval.
  void tick();
  logger.info({ instanceId, jobs: JOBS.map((j) => j.name) }, "Background worker started");
}

export async function stopWorker(): Promise<void> {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  await releaseLease().catch(() => undefined);
}
