import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Persistent Arcus conversation, one thread per treasury. Operators of a
 * treasury share its thread; history survives refreshes and server restarts.
 * Only real exchanges are stored (never errors).
 */
export const agentChatMessagesTable = pgTable(
  "agent_chat_messages",
  {
    id: text("id").primaryKey(),
    treasuryId: text("treasury_id").notNull().default("main"),
    /** "user" | "agent" */
    role: text("role").notNull(),
    content: text("content").notNull(),
    /** Wallet of the authenticated operator who asked, when known. */
    wallet: text("wallet"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_chat_created_idx").on(table.createdAt),
    index("agent_chat_treasury_idx").on(table.treasuryId, table.createdAt),
  ],
);

export type AgentChatMessageRow = typeof agentChatMessagesTable.$inferSelect;
