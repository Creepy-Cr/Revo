import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getChainStatus } from "../lib/chain";
import { checkVenue, type VenueStatus } from "../lib/uniswap-v4";
import { alertWebhookUrl } from "../lib/alerts";

const router: IRouter = Router();
const VENUE_TTL_MS = 30_000;
let venueCache: { value: VenueStatus; at: number } | null = null;

async function venueStatus(): Promise<VenueStatus> {
  if (venueCache && Date.now() - venueCache.at < VENUE_TTL_MS) return venueCache.value;
  const value = await checkVenue();
  venueCache = { value, at: Date.now() };
  return value;
}

/** Test seam for the relatively long-lived venue health cache. */
export function resetHealthCache(): void {
  venueCache = null;
}

/**
 * Production-grade health check: verifies the real dependencies (Postgres,
 * market data upstream, Arc RPC) instead of returning an
 * unconditional ok. Database failure marks the service degraded with a 503
 * so orchestrators can act on it; market/chain issues are reported but keep
 * the endpoint at 200 because the API still serves persisted state.
 */
router.get("/healthz", async (_req, res) => {
  // The DB probe is raced against a short timeout so a saturated pool or a
  // network stall can never hang /healthz past the orchestrator's patience.
  // It also reports whether the treasury state row exists yet: on a pristine
  // database, initialization REQUIRES a live market quote, so an unavailable
  // market is fatal (not merely degraded) until the first row is written.
  const dbProbe = Promise.race([
    db.execute(sql`select 1`).then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), 3_000).unref(),
    ),
  ]).catch(() => false);

  const [dbOk, chain, venue] = await Promise.all([
    dbProbe,
    getChainStatus(),
    venueStatus(),
  ]);
  const contractsDeployed =
    venue.poolManagerDeployed &&
    venue.quoterDeployed &&
    venue.routerDeployed &&
    venue.permit2Deployed;
  const aiConfigured = Boolean(
    process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
      process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY,
  );
  const alertsConfigured = Boolean(alertWebhookUrl());
  const requiredHealthy = dbOk && chain.connected && venue.reachable && contractsDeployed;
  const degraded = requiredHealthy && (
    venue.livePools.length === 0 || !aiConfigured || !alertsConfigured
  );
  const status = !requiredHealthy ? "down" : degraded ? "degraded" : "ok";

  res.status(status === "down" ? 503 : 200).json({
    status,
    checks: {
      db: { connected: dbOk },
      rpc: {
        connected: chain.connected,
        providers: (chain.providers ?? []).map(
          ({ label, reachable, blockNumber, latencyMs, error }) => ({
            label, reachable, blockNumber, latencyMs, error,
          }),
        ),
      },
      venue: {
        reachable: venue.reachable,
        contractsDeployed,
        livePools: venue.livePools.length,
      },
      ai: { configured: aiConfigured },
      alerts: { configured: alertsConfigured },
    },
  });
});

export default router;
