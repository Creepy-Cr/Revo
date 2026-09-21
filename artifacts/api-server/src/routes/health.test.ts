import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const getChainStatus = vi.fn();
const checkVenue = vi.fn();

vi.mock("@workspace/db", () => ({ db: { execute } }));
vi.mock("../lib/chain", () => ({ getChainStatus }));
vi.mock("../lib/uniswap-v4", () => ({ checkVenue }));

const { default: healthRouter, resetHealthCache } = await import("./health");

let server: ReturnType<ReturnType<typeof express>["listen"]>;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(healthRouter);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No health test port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  resetHealthCache();
  process.env.ALERT_WEBHOOK_URL = "https://alerts.example.test/hook";
  process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL = "https://ai.example.test";
  process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY = "configured";
  execute.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  getChainStatus.mockResolvedValue({
    connected: true,
    providers: [{
      label: "primary", reachable: true, blockNumber: 123, latencyMs: 10, error: null,
    }],
  });
  checkVenue.mockResolvedValue({
    reachable: true,
    poolManagerDeployed: true,
    quoterDeployed: true,
    routerDeployed: true,
    permit2Deployed: true,
    livePools: [{ poolId: "0x1" }],
  });
});

async function health(): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${baseUrl}/healthz`);
  return { response, body: await response.json() };
}

describe("/healthz", () => {
  it("reports ok when required and optional dependencies are ready", async () => {
    const { response, body } = await health();
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.checks.rpc.providers[0]).toMatchObject({ label: "primary", reachable: true });
    expect(body.checks.venue).toMatchObject({ contractsDeployed: true, livePools: 1 });
  });

  it("reports degraded when an optional dependency is unconfigured", async () => {
    delete process.env.ALERT_WEBHOOK_URL;
    const { response, body } = await health();
    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.alerts.configured).toBe(false);
  });

  it("reports down when a required dependency fails", async () => {
    getChainStatus.mockResolvedValue({ connected: false, providers: [] });
    const { response, body } = await health();
    expect(response.status).toBe(503);
    expect(body.status).toBe("down");
  });
});