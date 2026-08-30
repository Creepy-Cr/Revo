import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Structured rules compiled ONCE from a natural-language instruction.
 * The execution engine enforces these stored rules deterministically -
 * the LLM never reinterprets them per action.
 */
export interface PolicyRules {
  /** Max % of the treasury in any single yield protocol (hard DAO cap: 35). */
  maxAllocationPct: number;
  /** Minimum % held in stablecoins (hard DAO floor: 25 liquid). */
  stablecoinReserveMinPct: number;
  /** Max tolerated portfolio drawdown % before de-risking. */
  drawdownLimitPct: number;
  /** Sizing of the directional sleeve. */
  riskTolerance: "low" | "medium" | "high";
}

export const policiesTable = pgTable("policies", {
  id: text("id").primaryKey(),
  treasuryId: text("treasury_id").notNull().default("main"),
  name: text("name").notNull(),
  summary: text("summary").notNull(),
  sourceCommand: text("source_command").notNull(),
  rules: jsonb("rules").$type<PolicyRules>().notNull(),
  /** draft | active | rejected | superseded */
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const insertPolicySchema = createInsertSchema(policiesTable).omit({
  createdAt: true,
});

export type InsertPolicy = z.infer<typeof insertPolicySchema>;
export type Policy = typeof policiesTable.$inferSelect;
