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