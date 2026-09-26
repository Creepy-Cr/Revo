import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { db, alertsTable, treasuriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { raiseAlert } from "./alerts";

const treasuryId = `test-alert-webhook-${randomUUID()}`;
const originalUrl = process.env.ALERT_WEBHOOK_URL;

beforeAll(async () => {
  await db.insert(treasuriesTable).values({
    id: treasuryId,
    name: "Alert webhook test",
    ownerWallet: `0x${randomUUID().replace(/-/g, "")}`,
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.ALERT_WEBHOOK_URL;
  else process.env.ALERT_WEBHOOK_URL = originalUrl;
  await db.delete(alertsTable).where(eq(alertsTable.treasuryId, treasuryId));
});

afterAll(async () => {
  await db.delete(alertsTable).where(eq(alertsTable.treasuryId, treasuryId));
  await db.delete(treasuriesTable).where(eq(treasuriesTable.id, treasuryId));
});

const input = {
  treasuryId,
  severity: "critical" as const,
  kind: "test.webhook",
  title: "Webhook delivery",
  detail: "A real alert occurred",
  data: { privateKey: "must-not-leave", balance: 12 },
};

describe("alert webhook delivery", () => {
  it("delivers a sanitized payload", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await raiseAlert(input);

    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(payload).toMatchObject({
      severity: "critical",
      kind: "test.webhook",
      source: "revo-treasury",
      data: { privateKey: "[REDACTED]", balance: 12 },
    });
  });

  it("retries a 503 and then delivers", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await raiseAlert(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends a redacted Discord message without mentions and confirms delivery", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/123/test-token";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"id":"discord-message-1"}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await raiseAlert({
      ...input,
      title: "Alert @everyone",
      detail: `Warning <@123> 0x${"a".repeat(64)}`,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(new URL(url).searchParams.get("wait")).toBe("true");
    const payload = JSON.parse(options.body as string);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.content).toContain("Revo CRITICAL: Alert @everyone");
    expect(payload.content).toContain("[REDACTED]");
    expect(payload.content).not.toContain(`0x${"a".repeat(64)}`);
    expect(payload).not.toHaveProperty("data");
    const [saved] = await db.select().from(alertsTable).where(eq(alertsTable.treasuryId, treasuryId));
    expect(saved?.deliveredAt).toBeTruthy();
  });

  it("retries a Discord rate limit and does not mark an unconfirmed message delivered", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://discord.com/api/webhooks/123/test-token";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response('{"id":"discord-message-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await raiseAlert(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await raiseAlert(input);
    expect(fetchMock).toHaveBeenCalledOnce();
    const rows = await db.select().from(alertsTable).where(eq(alertsTable.treasuryId, treasuryId));
    expect(rows.filter((row) => row.deliveredAt === null)).toHaveLength(1);
  });

  it("gives up after retries without throwing", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(raiseAlert(input)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("skips delivery when unset", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await raiseAlert(input);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});