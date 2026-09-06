import { eq } from "drizzle-orm";
import { db, treasurySettingsTable } from "@workspace/db";

/**
 * The treasury's operating mode: how much the agent is allowed to do without
 * an operator.
 *
 * It lives in `treasury_settings.mode` and nowhere else. Every guard that
 * matters - proposal approval, policy activation, the rebalance engine -
 * reads it from there, so anything that *reports* the mode has to read the
 * same row. A second stored copy is worse than no copy at all: the treasury
 * state row used to keep one, frozen at "AUTONOMOUS" from initialisation, and
 * the console went on showing AUTO-EXECUTE after an operator switched into
 * Safe mode. Overstating the agent's authority is the worst direction for
 * this to be wrong in.
 */
export type OperatingMode = "safe" | "managed" | "autonomous";

/** How each mode is labelled to operators (console header badge, activity log). */
export const MODE_LABEL: Record<OperatingMode, string> = {
  safe: "SAFE",
  managed: "MANAGED",
  autonomous: "AUTONOMOUS",
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Executor type so a mode read can join a caller's transaction. */
export type DbOrTx = typeof db | Tx;

/**
 * Reads the operating mode, creating the settings row on first read so an
 * operator always has something to switch away from.
 *
 * A missing or unrecognised value resolves to "managed", never "autonomous":
 * the fallback must not hand the agent execution rights nobody granted.
 */
export async function getMode(treasuryId: string, executor: DbOrTx = db): Promise<OperatingMode> {
  await executor
    .insert(treasurySettingsTable)
    .values({ id: treasuryId, mode: "managed" })
    .onConflictDoNothing({ target: treasurySettingsTable.id });
  const [settings] = await executor
    .select()
    .from(treasurySettingsTable)
    .where(eq(treasurySettingsTable.id, treasuryId));
  const mode = settings?.mode;
  return mode === "safe" || mode === "autonomous" ? mode : "managed";
}
