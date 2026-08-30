import { randomUUID } from "node:crypto";
import { alertsTable, db } from "@workspace/db";
import { logger } from "./logger";

export interface AlertInput {
  severity: "info" | "warning" | "critical";
  kind: string;
  title: string;
  detail: string;
  /** Owning treasury; omit for platform-wide events (e.g. worker failures). */
  treasuryId?: string | null;
  data?: unknown;
}

/**
 * Persist an alert to the durable outbox. Alerts record real observed
 * events; delivery channels (when configured) mark deliveredAt separately.
 * Best-effort: an alert failure must never break the operation that raised it.
 */
export async function raiseAlert(input: AlertInput): Promise<void> {
  try {
    await db.insert(alertsTable).values({
      id: `alert-${randomUUID()}`,
      treasuryId: input.treasuryId ?? null,
      severity: input.severity,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      data: input.data ?? null,
    });
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, "Failed to persist alert");
  }
}
