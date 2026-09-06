import { Router, type IRouter } from "express";
import {
  GetTreasurySwapVenueResponse,
  QuoteTreasurySwapBody,
  QuoteTreasurySwapResponse,
} from "@workspace/api-zod";
import { requireOperator } from "../lib/auth";
import { llmGuard } from "../lib/llm-guard";
import { ARC_TOKENS } from "../lib/arc-tokens";
import { getMarketQuote, referencePriceFor } from "../lib/market";
import { getTowerRegistry, isTowerConfigured } from "../lib/tower";
import {
  ARC_CHAIN_ID,
  SYNTHRA_ROUTER,
  checkSynthraVenue,
  getSynthraQuote,
} from "../lib/synthra";

const router: IRouter = Router();

/**
 * Quoting is rate-limited for the same reason policy compilation is: this API
 * is a public testnet demo and each call fans out to several RPC round trips.
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
 * Two different things are probed. Synthra's contracts on Arc are what a swap
 * would actually execute against, so their presence decides `swapEnabled`. The
 * Tower catalogue is a secondary cross-check on token addresses; losing it
 * degrades validation but does not stop a trade, so it does not gate here.
 */
router.get("/treasury/swap/venue", requireOperator(), async (_req, res): Promise<void> => {
  const configured = isTowerConfigured();
  const [registry, synthra] = await Promise.all([
    configured
      ? getTowerRegistry()
      : Promise.resolve({ available: false, arcSupportsSwaps: false, error: undefined }),
    checkSynthraVenue(),
  ]);

  const contractsDeployed =
    synthra.factoryDeployed && synthra.quoterDeployed && synthra.routerDeployed;
  const swapEnabled = synthra.reachable && contractsDeployed;

  let reason: string | undefined;
  if (!synthra.reachable) {
    reason = synthra.error ?? "Arc RPC is unreachable, so no swap can be quoted or signed";
  } else if (!contractsDeployed) {
    reason = "The Synthra factory, quoter or router is not deployed at the pinned address on Arc";
  } else if (!configured) {
    reason =
      "Swaps are live, but no venue-catalogue credentials are configured so token addresses cannot be cross-checked";
  } else if (!registry.available) {
    reason = registry.error ?? "The venue catalogue could not be read, so addresses are unverified";
  }

  res.json(
    GetTreasurySwapVenueResponse.parse({
      venue: "synthra",
      chainId: ARC_CHAIN_ID,
      network: "Arc Testnet",
      routerAddress: SYNTHRA_ROUTER,
      configured,
      registryAvailable: registry.available,
      arcSupportsSwaps: registry.arcSupportsSwaps,
      rpcReachable: synthra.reachable,
      contractsDeployed,
      blockNumber: synthra.blockNumber,
      swapEnabled,
      tokens: Object.values(ARC_TOKENS).map((token) => ({
        symbol: token.symbol,
        name: token.name,
        address: token.address,
        decimals: token.decimals,
        role: token.role,
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

    // Reference prices come from the token's own CoinGecko id rather than a
    // symbol switch, so adding a token cannot silently ship without the
    // independent price check that gates whether it may be traded at all.
    const market = await getMarketQuote();
    const inputId = ARC_TOKENS[inputSymbol]?.coingeckoId;
    const outputId = ARC_TOKENS[outputSymbol]?.coingeckoId;
    const inputUsd = inputId ? referencePriceFor(inputId, market) : undefined;
    const outputUsd = outputId ? referencePriceFor(outputId, market) : undefined;

    const quote = await getSynthraQuote({
      inputSymbol,
      outputSymbol,
      amount,
      ...(inputUsd !== undefined && outputUsd !== undefined
        ? { referenceUsd: { input: inputUsd, output: outputUsd } }
        : {}),
    });

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
