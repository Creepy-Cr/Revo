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
  /** Structured allocation targets the approved rebalance settles towards. */
  targetAllocations: jsonb("target_allocations").$type<AllocationTarget[]>(),
  /**
   * Arc transaction hash of the swap settling this rebalance. Written immediately
   * BEFORE the swap is broadcast, so `executed` without a hash is impossible
   * for any proposal that carried allocation targets, and an `approved`
   * proposal with no hash proves nothing was ever sent - which is what lets
   * reconciliation recover an interrupted settlement without re-sending it.
   */
  executionTxHash: text("execution_tx_hash"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

export const insertTreasuryProposalSchema = createInsertSchema(
  treasuryProposalsTable,
).omit({ createdAt: true });

export type InsertTreasuryProposal = z.infer<
  typeof insertTreasuryProposalSchema
>;
export type TreasuryProposal = typeof treasuryProposalsTable.$inferSelect;