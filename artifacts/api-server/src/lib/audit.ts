import { createHash, randomUUID } from "node:crypto";
import { desc, sql } from "drizzle-orm";
import { auditEventsTable, db } from "@workspace/db";
import { logger } from "./logger";

/**
 * Append-only, hash-chained audit log for privileged mutations.
 *
 * Each event's `hash` is SHA-256 over the previous event's hash plus a
 * canonical JSON encoding of the event fields, so any retroactive edit or
 * deletion breaks verification from that point forward. Inserts serialize on
 * an advisory lock to keep the chain strictly linear. Secrets, tokens, and
 * full signatures must never be passed in `detail`.
 */

export interface AuditInput {
  action: string;
  result: "ok" | "denied" | "failed";
  /**
   * Owning treasury (tenant) for filtering; null for platform-level events.
   * Stored as a column only - deliberately NOT part of the hash payload so
   * the pre-multi-tenant chain still verifies end to end.
   */
  treasuryId?: string | null;
  actorWallet?: string | null;
  actorRole?: string | null;
  sessionId?: string | null;
  requestId?: string | null;
  resourceId?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
}

const GENESIS_HASH = "0".repeat(64);

/**
 * Deterministic JSON shape: object keys sorted recursively. Postgres jsonb
 * normalizes key order on storage, so both hashing (write) and verification
 * (read-back) must canonicalize or identical events would hash differently.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('audit-chain'))`);
    const [last] = await tx
      .select({ seq: auditEventsTable.seq, hash: auditEventsTable.hash })
      .from(auditEventsTable)
      .orderBy(desc(auditEventsTable.seq))
      .limit(1);
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const time = new Date();
    const payload = JSON.stringify([
      seq,
      time.toISOString(),
      input.actorWallet ?? null,
      input.actorRole ?? null,
      input.sessionId ?? null,
      input.requestId ?? null,
      input.action,
      input.resourceId ?? null,
      input.result,
      input.reason ?? null,
      canonicalize(input.detail ?? null),
    ]);
    const hash = createHash("sha256").update(prevHash).update(payload).digest("hex");
    await tx.insert(auditEventsTable).values({
      id: `audit-${randomUUID()}`,
      treasuryId: input.treasuryId ?? null,
      seq,
      time,
      actorWallet: input.actorWallet ?? null,
      actorRole: input.actorRole ?? null,
      sessionId: input.sessionId ?? null,
      requestId: input.requestId ?? null,
      action: input.action,
      resourceId: input.resourceId ?? null,
      result: input.result,
      reason: input.reason ?? null,
      detail: input.detail ?? null,
      prevHash,
      hash,
    });
  });
}

/** Best-effort audit write: the primary action must never fail on logging. */
export async function auditSafe(input: AuditInput): Promise<void> {
  try {
    await recordAudit(input);
  } catch (error) {
    logger.error({ err: error, action: input.action }, "Audit event write failed");
  }
}

/** Verifies the whole chain; returns the first broken sequence number or null. */
export async function verifyAuditChain(): Promise<{ events: number; brokenAtSeq: number | null }> {
  const rows = await db.select().from(auditEventsTable).orderBy(auditEventsTable.seq);
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const payload = JSON.stringify([
      row.seq,
      row.time.toISOString(),
      row.actorWallet,
      row.actorRole,
      row.sessionId,
      row.requestId,
      row.action,
      row.resourceId,
      row.result,
      row.reason,
      canonicalize(row.detail),
    ]);
    const expected = createHash("sha256").update(prevHash).update(payload).digest("hex");
    if (row.prevHash !== prevHash || row.hash !== expected) {
      return { events: rows.length, brokenAtSeq: row.seq };
    }
    prevHash = row.hash;
  }
  return { events: rows.length, brokenAtSeq: null };
}
