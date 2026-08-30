import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface AllocationTarget {
  symbol: string;
  percentage: number;
}

export const treasuryProposalsTable = pgTable("treasury_proposals", {
  id: text("id").primaryKey(),
  treasuryId: text("treasury_id").notNull().default("main"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  action: text("action").notNull(),
  safetyChecks: jsonb("safety_checks").$type<string[]>().notNull(),
  command: text("command").notNull(),
  /** Policy that generated this proposal (null for legacy one-off proposals). */
  policyId: text("policy_id"),
  /** Structured allocation targets the simulated rebalance applies on approval. */
  targetAllocations: jsonb("target_allocations").$type<AllocationTarget[]>(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const insertTreasuryProposalSchema = createInsertSchema(
  treasuryProposalsTable,
).omit({ createdAt: true });

export type InsertTreasuryProposal = z.infer<
  typeof insertTreasuryProposalSchema
>;
export type TreasuryProposal = typeof treasuryProposalsTable.$inferSelect;