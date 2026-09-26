import { randomUUID } from "node:crypto";
import { alertsTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
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

/** Optional outbound alert destination, configured with ALERT_WEBHOOK_URL. */
export function alertWebhookUrl(): string | null {
  const value = process.env.ALERT_WEBHOOK_URL?.trim();
  return value || null;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/-----BEGIN (?:EC |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |RSA )?PRIVATE KEY-----/g, "[REDACTED]")
      .replace(/\b0x[a-fA-F0-9]{64}\b/g, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        /secret|private.?key|api.?key|password|token/i.test(key) ? "[REDACTED]" : redact(nested),
      ]),
    );
  }
  return value;
}

async function deliverWebhook(
  url: string,
  payload: Record<string, unknown>,
  discord = false,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        if (!discord) return true;
        // With wait=true Discord confirms the message was saved.
        // Do not retry an accepted request if its response cannot be parsed.
        let message: { id?: unknown } | null = null;
        try {
          message = await response.json() as { id?: unknown };
        } catch {
          // Discord may have saved the alert.
        }
        if (typeof message?.id === "string" && message.id.length > 0) return true;
        logger.warn("Discord accepted the alert but did not confirm a saved message");
        return false;
      }
      if ((response.status !== 429 && response.status < 500) || attempt === 2) {
        logger.warn({ status: response.status, attempt: attempt + 1 }, "Alert webhook rejected delivery");
        return false;
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter * 1000, 5_000)));
          continue;
        }
      }
    } catch (error) {
      if (attempt === 2) {
        logger.warn({ err: error, attempt: attempt + 1 }, "Alert webhook delivery failed");
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
  }
  return false;
}

function discordWebhook(url: URL): boolean {
  return ["discord.com", "discordapp.com"].includes(url.hostname.toLowerCase()) &&
    /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname);
}

function discordPayload(body: Record<string, unknown>): Record<string, unknown> {
  const content = [
    `**Revo ${String(body.severity).toUpperCase()}: ${String(body.title)}**`,
    String(body.detail),
    `Type: ${String(body.kind)}`,
    `Treasury: ${String(body.treasuryId ?? "platform")}`,
    `Time: ${String(body.createdAt)}`,
  ].join("\n");
  return {
    content: content.length > 1900 ? `${content.slice(0, 1899)}…` : content,
    allowed_mentions: { parse: [] },
  };
}

/**
 * Persist an alert to the durable outbox. Alerts record real observed
 * events; delivery channels (when configured) mark deliveredAt separately.
 * Best-effort: an alert failure must never break the operation that raised it.
 */
export async function raiseAlert(input: AlertInput): Promise<void> {
  const id = `alert-${randomUUID()}`;
  const createdAt = new Date();
  try {
    await db.insert(alertsTable).values({
      id,
      treasuryId: input.treasuryId ?? null,
      time: createdAt,
      severity: input.severity,
      kind: input.kind,
      title: input.title,
      detail: input.detail,
      data: input.data ?? null,
    });
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, "Failed to persist alert");
    return;
  }

  const url = alertWebhookUrl();
  if (!url) return;
  try {
    const body: Record<string, unknown> = {
      severity: input.severity,
      kind: input.kind,
      title: redact(input.title),
      detail: redact(input.detail),
      treasuryId: input.treasuryId ?? null,
      data: redact(input.data ?? null),
      createdAt: createdAt.toISOString(),
      source: "revo-treasury",
    };
    const destination = new URL(url);
    if (destination.hostname.toLowerCase() === "hooks.slack.com") {
      body.text = `${input.severity.toUpperCase()}: ${input.title} - ${input.detail}`.replace(/\s+/g, " ");
      body.text = redact(body.text);
    }
    const isDiscord = discordWebhook(destination);
    if (isDiscord) destination.searchParams.set("wait", "true");
    if (await deliverWebhook(
      isDiscord ? destination.toString() : url,
      isDiscord ? discordPayload(body) : body,
      isDiscord,
    )) {
      await db
        .update(alertsTable)
        .set({ deliveredAt: new Date() })
        .where(eq(alertsTable.id, id));
    }
  } catch (error) {
    logger.warn({ err: error, kind: input.kind }, "Alert webhook delivery failed");
  }
}
