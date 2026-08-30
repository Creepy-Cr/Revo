import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { getMarketQuote } from "../lib/market";
import { getChainStatus } from "../lib/chain";

const router: IRouter = Router();

/**
 * Production-grade health check: verifies the real dependencies (Postgres,
 * market data upstream, Arc Testnet RPC) instead of returning an
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
    db
      .execute(sql`select exists(select 1 from treasury_state) as initialized`)
      .then(
        (result) =>
          ({
            check: "ok",
            initialized: Boolean(
              (result.rows?.[0] as { initialized?: boolean } | undefined)?.initialized,
            ),
          }) as const,
      ),
    new Promise<{ check: "error"; initialized: false }>((resolve) =>
      setTimeout(() => resolve({ check: "error", initialized: false }), 3_000).unref(),
    ),
  ]).catch(() => ({ check: "error", initialized: false }) as const);

  const [dbResult, marketCheck, chainCheck] = await Promise.all([
    dbProbe,
    getMarketQuote().then((quote) =>
      quote ? (quote.stale ? "stale" : "ok") : "unavailable",
    ),
    getChainStatus().then((chain) =>
      chain.connected ? "ok" : chain.stale ? "stale" : "error",
    ),
  ]);
  const dbCheck = dbResult.check;

  // Market failure only takes the service down while the treasury cannot
  // initialize without it; once state exists, persisted data still serves.
  const marketFatal = marketCheck === "unavailable" && !dbResult.initialized;
  const degraded =
    dbCheck !== "ok" || marketCheck !== "ok" || chainCheck !== "ok";

  res.status(dbCheck === "ok" && !marketFatal ? 200 : 503).json({
    status: degraded ? "degraded" : "ok",
    checks: { database: dbCheck, market: marketCheck, chain: chainCheck },
  });
});

export default router;
