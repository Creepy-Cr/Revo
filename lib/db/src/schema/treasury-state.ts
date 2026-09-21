import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Persistent treasury state.
 *
 * Composition is read from the custody wallet on Arc, so this row is not the
 * treasury's holdings. `usdcUnits` is the deposit ledger - what confirmed
 * on-chain transfers say the treasury was credited - and it is only rendered
 * when Arc cannot be read. `lastUsdcPrice` is the last real quote, kept so a
 * degraded read still prices that fallback at a price that once existed.
 *
 * Columns for assets the treasury cannot hold on Arc (aUSDC, sUSDC, ETH) used
 * to live here at a permanent zero, alongside a stored ETH price nothing read.
 * They are gone: a column that describes a position no wallet can hold will be
 * read as a position by anyone inspecting this table.
 *
 * `status` and `network` are gone for the same reason. Both were written once
 * at initialisation ("AUTONOMOUS", "Arc") and never updated again, so
 * the console kept showing AUTO-EXECUTE after an operator switched the
 * treasury into Safe mode. The operating mode lives in
 * `treasury_settings.mode` - the value the approval, policy and engine guards
 * actually enforce - and the chain name comes from the chain config, so
 * neither has a stored copy here to fall out of date.
 */
export const treasuryStateTable = pgTable("treasury_state", {
  id: text("id").primaryKey(),
  usdcUnits: doublePrecision("usdc_units").notNull(),
  lastUsdcPrice: doublePrecision("last_usdc_price").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TreasuryState = typeof treasuryStateTable.$inferSelect;

/** Append-only NAV history, one snapshot per throttle window per treasury. */
export const navSnapshotsTable = pgTable("nav_snapshots", {
  id: text("id").primaryKey(),
  treasuryId: text("treasury_id").notNull().default("main"),
  time: timestamp("time", { withTimezone: true }).notNull().defaultNow(),
  value: doublePrecision("value").notNull(),
});

export type NavSnapshot = typeof navSnapshotsTable.$inferSelect;

/**
 * Append-only agent activity log driven by real events.
 *
 * `kind` makes the real-vs-simulated distinction machine-readable rather than
 * something a reader has to infer from the wording of `title`:
 *   - "onchain"   a real Arc transaction settled
 *   - "simulated" internal accounting only; no protocol swap, no transaction
 *   - "system"    governance/control event that moves no funds at all
 *
 * Defaults to "system" so a row can never accidentally claim to be on-chain.
 */
export const agentActivitiesTable = pgTable("agent_activities", {
  id: text("id").primaryKey(),
  treasuryId: text("treasury_id").notNull().default("main"),
  time: timestamp("time", { withTimezone: true }).notNull().defaultNow(),
  title: text("title").notNull(),
  detail: text("detail").notNull(),
  status: text("status").notNull(),
  kind: text("kind").notNull().default("system"),
  /**
   * Arc transaction this row reports on, when there is one. Kept as a
   * column rather than embedded in `detail` so the console can render a real
   * explorer link instead of leaving an operator to copy a hash out of prose.
   */
  txHash: text("tx_hash"),
});

export type AgentActivity = typeof agentActivitiesTable.$inferSelect;
