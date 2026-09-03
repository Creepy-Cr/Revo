import { doublePrecision, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Persistent treasury simulation state. Holdings are stored as units, not
 * dollar values - valuations are computed at read time from live market
 * prices so the NAV genuinely moves with the market.
 */
export const treasuryStateTable = pgTable("treasury_state", {
  id: text("id").primaryKey(),
  usdcUnits: doublePrecision("usdc_units").notNull(),
  aUsdcUnits: doublePrecision("a_usdc_units").notNull(),
  sUsdcUnits: doublePrecision("s_usdc_units").notNull(),
  ethUnits: doublePrecision("eth_units").notNull(),
  lastEthPrice: doublePrecision("last_eth_price").notNull(),
  lastUsdcPrice: doublePrecision("last_usdc_price").notNull(),
  status: text("status").notNull(),
  network: text("network").notNull(),
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
 *   - "onchain"   a real Arc Testnet transaction settled
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
});

export type AgentActivity = typeof agentActivitiesTable.$inferSelect;
