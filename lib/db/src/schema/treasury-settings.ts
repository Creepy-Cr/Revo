import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Single-row settings table for the treasury.
 * `mode` is one of: safe | managed | autonomous (default managed).
 */
export const treasurySettingsTable = pgTable("treasury_settings", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull().default("managed"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTreasurySettingsSchema = createInsertSchema(
  treasurySettingsTable,
).omit({ updatedAt: true });

export type InsertTreasurySettings = z.infer<typeof insertTreasurySettingsSchema>;
export type TreasurySettings = typeof treasurySettingsTable.$inferSelect;
