import { Router, type IRouter } from "express";
import {
  GetTreasurySwapVenueResponse,
  QuoteTreasurySwapBody,
  QuoteTreasurySwapResponse,
} from "@workspace/api-zod";
import { requireOperator } from "../lib/auth";
import { llmGuard } from "../lib/llm-guard";
import { ARC_TOKENS, describePriceSource, priceIdOf } from "../lib/arc-tokens";
import { getMarketQuote, referenceEntryFor } from "../lib/market";
import { isCurrentReference } from "../lib/custody-policy";
import { getTowerRegistry, isTowerConfigured } from "../lib/tower";
import { ARC_CHAIN_ID, ARC_CHAIN_NAME, ChainError } from "../lib/arc-chain";
import { UNIVERSAL_ROUTER, VENUE, checkVenue, getSwapQuote } from "../lib/uniswap-v4";

const router: IRouter = Router();

/**
 * Quoting is rate-limited for the same reason policy compilation is: each
 * call fans out to a dozen RPC round trips across the public Arc providers.
 * The guard is shared rather than reimplemented.
 */
const quoteGuard = llmGuard({
  scope: "swap quoting",
  windowMs: 60_000,
  maxPerWindow: 12,
  maxConcurrent: 3,
});

/**
 * Whether a real swap venue is usable right now.
 *
 * Deliberately separate from quoting: an operator needs to be able to tell "the
 * venue is down" apart from "this particular pair has no liquidity", and a
 * single quote endpoint conflates the two.
 *
 * Two different things are probed. Uniswap v4's contracts on Arc and at least
 * one live pinned pool are what a swap would actually execute against, so they
 * decide `swapEnabled`. The Tower catalogue is a secondary cross-check on
 * token addresses; losing it degrades validation but does not stop a trade,
 * so it does not gate here.
 */
router.get("/treasury/swap/venue", requireOperator(), async (_req, res): Promise<void> => {
  const configured = isTowerConfigured();
  const [registry, venue] = await Promise.all([
    configured
      ? getTowerRegistry()
      : Promise.resolve({ available: false, arcSupportsSwaps: false, error: undefined }),
    checkVenue(),
  ]);

  const contractsDeployed =
    venue.poolManagerDeployed &&
    venue.quoterDeployed &&
    venue.routerDeployed &&
    venue.permit2Deployed;
  const poolLive = venue.livePools.length > 0;
  const swapEnabled = venue.reachable && contractsDeployed && poolLive;

  let reason: string | undefined;
  if (!venue.reachable) {
    reason = venue.error ?? "Arc RPC is unreachable, so no swap can be quoted or signed";
  } else if (!contractsDeployed) {
    reason =
      "The Uniswap v4 PoolManager, quoter, router or Permit2 is not deployed at the pinned address on Arc";
  } else if (!poolLive) {
    reason = "None of Revo's pinned Uniswap v4 pools currently has in-range liquidity";
  } else if (!configured) {
    reason =
      "Swaps are live, but no venue-catalogue credentials are configured so token addresses cannot be cross-checked";
  } else if (!registry.available) {
    reason = registry.error ?? "The venue catalogue could not be read, so addresses are unverified";
  }

  res.json(
    GetTreasurySwapVenueResponse.parse({
      venue: VENUE,
      chainId: ARC_CHAIN_ID,
      network: ARC_CHAIN_NAME,
      routerAddress: UNIVERSAL_ROUTER,
      configured,
      registryAvailable: registry.available,
      arcSupportsSwaps: registry.arcSupportsSwaps,
      rpcReachable: venue.reachable,
      contractsDeployed,
      blockNumber: venue.blockNumber,
      livePools: venue.livePools,
      swapEnabled,
      tokens: Object.values(ARC_TOKENS).map((token) => ({
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        role: token.role,
        issuer: token.issuer,
        priceSource: describePriceSource(token.price),
        pools: token.pools.map((p) => ({ feeTier: p.fee, tickSpacing: p.tickSpacing })),
        tradable: token.tradable,
        ...(token.untradableReason ? { untradableReason: token.untradableReason } : {}),
      })),
      ...(reason ? { reason } : {}),
      checkedAt: new Date().toISOString(),
    }),
  );
});

/**
 * Price a swap without executing it.
 *
 * Quoting stops here by design. The result feeds the approval layer; nothing on
 * this path signs or broadcasts, and a route that must not be traded is
 * returned as an ordinary result carrying its reason rather than as an error.
 */
router.post(
  "/treasury/swap/quote",
  requireOperator(["strategist", "approver"]),
  quoteGuard,
  async (req, res): Promise<void> => {
    const parsed = QuoteTreasurySwapBody.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ errors: parsed.error.message }, "Invalid swap quote request");
      res.status(400).json({ error: "inputSymbol, outputSymbol and a decimal amount are required" });
      return;
    }
    const { inputSymbol, outputSymbol, amount } = parsed.data;

    // Reference prices come from the token's own registered price source
    // rather than a symbol switch, so adding a token cannot silently ship
    // without the independent price check that gates whether it may be
    // traded at all. Only a current price counts: a stale one is withheld,
    // and the quote then refuses for want of a reference rather than
    // checking the pool against a market that has since moved.
    const market = await getMarketQuote();
    const currentUsd = (symbol: string): number | undefined => {
      const token = ARC_TOKENS[symbol];
      const entry = token ? referenceEntryFor(priceIdOf(token.price), market) : undefined;
      return entry && isCurrentReference(entry) ? entry.usd : undefined;
    };
    const inputUsd = currentUsd(inputSymbol);
    const outputUsd = currentUsd(outputSymbol);

    let quote;
    try {
      quote = await getSwapQuote({
        inputSymbol,
        outputSymbol,
        amount,
        ...(inputUsd !== undefined && outputUsd !== undefined
          ? { referenceUsd: { input: inputUsd, output: outputUsd } }
          : {}),
      });
    } catch (error) {
      if (error instanceof ChainError && error.code === "RPC_UNAVAILABLE") {
        req.log.warn({ err: error, inputSymbol, outputSymbol }, "Swap quote unavailable: Arc RPC failed");
        res.status(503).json({ error: "Arc RPC is temporarily unavailable, so the swap could not be priced. Try again shortly." });
        return;
      }
      throw error;
    }

    if (!quote.tradable) {
      req.log.info(
        { inputSymbol, outputSymbol, amount, reason: quote.reason },
        "Swap quote is not tradable",
      );
    }

    res.json(QuoteTreasurySwapResponse.parse(quote));
  },
);

export default router;
