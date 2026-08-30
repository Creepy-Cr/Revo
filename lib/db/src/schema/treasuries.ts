import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * One treasury per tenant. Every wallet that signs in for the first time gets
 * its own treasury (it becomes the owner/admin); additional operators can be
 * invited into a treasury via the security panel.
 *
 * All treasury-scoped rows either carry a `treasuryId` column or - for the
 * strict one-row-per-treasury tables (treasury_state, treasury_settings,
 * security_controls, treasury_wallet) - use the treasury id AS their primary
 * key. The founding treasury keeps the historical id "main" so existing
 * state/custody rows stay attached without a data rewrite.
 */
export const treasuriesTable = pgTable("treasuries", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Lowercased wallet that created (and owns) this treasury. */
  ownerWallet: text("owner_wallet").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Treasury = typeof treasuriesTable.$inferSelect;
