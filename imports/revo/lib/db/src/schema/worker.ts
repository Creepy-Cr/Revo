import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Lease-based leader election for the durable background worker. Works with
 * pooled connections (unlike session advisory locks): the leader renews its
 * lease each tick; another instance may take over only after expiry.
 */
export const workerLeasesTable = pgTable("worker_leases", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkerLease = typeof workerLeasesTable.$inferSelect;

/**
 * Durable per-job state: last run/success timestamps, last error, and a
 * jsonb checkpoint (e.g. the deposit indexer's last scanned block) so jobs
 * resume exactly where they left off across restarts.
 */
export const workerStateTable = pgTable("worker_state", {
  id: text("id").primaryKey(),
  checkpoint: jsonb("checkpoint"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type WorkerState = typeof workerStateTable.$inferSelect;

/**
 * Persistent alert outbox. Alerts are real observed events (drawdown
 * breaches, worker failures, security events) written durably; delivery
 * channels mark deliveredAt when/if they ship the alert externally.
 */
export const alertsTable = pgTable("alerts", {
  id: text("id").primaryKey(),
  /** Owning treasury; null for platform-wide events (e.g. worker failures). */
  treasuryId: text("treasury_id"),
  time: timestamp("time", { withTimezone: true }).notNull().defaultNow(),
  severity: text("severity").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  data: jsonb("data"),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
});

export type Alert = typeof alertsTable.$inferSelect;
