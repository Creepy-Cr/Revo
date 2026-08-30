import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Operator registry: wallets allowed to act on the treasury and their role.
 * Roles: viewer | strategist | approver | guardian | admin.
 * Wallet addresses are stored lowercased.
 */
export const operatorsTable = pgTable("operators", {
  wallet: text("wallet").primaryKey(),
  /**
   * The treasury this wallet operates. One wallet belongs to exactly one
   * treasury (its own, or one it was invited into by that treasury's admin).
   */
  treasuryId: text("treasury_id").notNull().default("main"),
  role: text("role").notNull(),
  addedBy: text("added_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Operator = typeof operatorsTable.$inferSelect;

/**
 * Short-lived, single-use SIWE-style login nonces. The exact signed message
 * is stored so verification recomputes against precisely what was issued.
 */
export const authNoncesTable = pgTable("auth_nonces", {
  id: text("id").primaryKey(),
  wallet: text("wallet").notNull(),
  nonce: text("nonce").notNull().unique(),
  message: text("message").notNull(),
  issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});

export type AuthNonce = typeof authNoncesTable.$inferSelect;

/**
 * DB-backed operator sessions. Only a SHA-256 hash of the bearer token is
 * stored; the raw token exists solely in the HttpOnly cookie.
 */
export const operatorSessionsTable = pgTable("operator_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  wallet: text("wallet").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export type OperatorSessionRow = typeof operatorSessionsTable.$inferSelect;

/**
 * Singleton security controls: emergency pause + persisted withdrawal caps.
 * Caps are USDC amounts; withdrawal enforcement is transactional.
 */
export const securityControlsTable = pgTable("security_controls", {
  id: text("id").primaryKey(),
  pauseActive: boolean("pause_active").notNull().default(false),
  pauseReason: text("pause_reason"),
  pauseActivatedBy: text("pause_activated_by"),
  pauseActivatedAt: timestamp("pause_activated_at", { withTimezone: true }),
  pauseDeactivatedBy: text("pause_deactivated_by"),
  pauseDeactivatedAt: timestamp("pause_deactivated_at", { withTimezone: true }),
  pauseRevision: integer("pause_revision").notNull().default(0),
  maxPerWithdrawalUsdc: doublePrecision("max_per_withdrawal_usdc").notNull(),
  maxWallet24hUsdc: doublePrecision("max_wallet_24h_usdc").notNull(),
  maxGlobal24hUsdc: doublePrecision("max_global_24h_usdc").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type SecurityControls = typeof securityControlsTable.$inferSelect;

/**
 * Append-only, hash-chained audit log. `hash` covers the event payload plus
 * `prevHash`, so any retroactive edit breaks the chain. Inserts are
 * serialized on an advisory lock to keep the chain linear.
 */
export const auditEventsTable = pgTable("audit_events", {
  id: text("id").primaryKey(),
  /** Owning treasury; null for platform-level events. Chain stays global. */
  treasuryId: text("treasury_id"),
  seq: integer("seq").notNull().unique(),
  time: timestamp("time", { withTimezone: true }).notNull(),
  actorWallet: text("actor_wallet"),
  actorRole: text("actor_role"),
  sessionId: text("session_id"),
  requestId: text("request_id"),
  action: text("action").notNull(),
  resourceId: text("resource_id"),
  result: text("result").notNull(),
  reason: text("reason"),
  detail: jsonb("detail").$type<Record<string, unknown> | null>(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull().unique(),
});

export type AuditEvent = typeof auditEventsTable.$inferSelect;
