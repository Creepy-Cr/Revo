import { Router, type IRouter } from "express";
import {
  GetTreasurySwapVenueResponse,
  QuoteTreasurySwapBody,
  QuoteTreasurySwapResponse,
} from "@workspace/api-zod";
import { requireOperator } from "../lib/auth";
import { llmGuard } from "../lib/llm-guard";
import { getMarketQuote, type MarketQuote } from "../lib/market";
import {
  ARC_TRADED_TOKENS,
  TOWER_CHAIN_ID,
  getSwapQuote,
  getTowerRegistry,
  isTowerConfigured,
} from "../lib/tower";

const router: IRouter = Router();

/**
 * Quoting is rate-limited for the same reason policy compilation is: every
 * call reaches a metered third party, and this API is a public testnet demo.
 * The guard is shared rather than reimplemented.
 */
const quoteGuard = llmGuard({
  scope: "swap quoting",
  windowMs: 60_000,
  maxPerWindow: 12,
  maxConcurrent: 3,
});

/**
 * Real-world USD price for a traded symbol, used only to sanity check a pool
 * rate. Returns undefined when no honest figure exists rather than guessing:
 * a wrong reference price would silently disable the check it exists to make.
 */
function referenceUsd(symbol: string, quote: MarketQuote | null): number | undefined {
  if (!quote) return undefined;
  if (symbol === "USDC") return quote.usdcUsd;
  if (symbol === "cirBTC") return quote.btcUsd;
  return undefined;
}

/**
 * Whether a real swap venue is usable right now.
 *
 * Deliberately separate from quoting: an operator needs to be able to tell
 * "the venue is down" apart from "this particular pair has no liquidity", and
 * a single quote endpoint conflates the two.
 */
router.get("/treasury/swap/venue", requireOperator(), async (_req, res): Promise<void> => {
  const configured = isTowerConfigured();
  const registry = configured
    ? await getTowerRegistry()
    : { available: false, arcSupportsSwaps: false, error: undefined };

  const swapEnabled = configured && registry.available && registry.arcSupportsSwaps;

  let reason: string | undefined;
  if (!configured) {
    reason = "No swap venue credentials are configured, so no real trade can be attempted";
  } else if (!registry.available) {
    reason = registry.error ?? "The swap venue registry could not be read";
  } else if (!registry.arcSupportsSwaps) {
    reason = "The venue no longer advertises swap support on Arc Testnet";
  }

  res.json(
    GetTreasurySwapVenueResponse.parse({
      venue: "tower",
      chainId: TOWER_CHAIN_ID,
      network: "Arc Testnet",
      configured,
      registryAvailable: registry.available,
      arcSupportsSwaps: registry.arcSupportsSwaps,
      swapEnabled,
      tokens: Object.values(ARC_TRADED_TOKENS).map((token) => ({
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        role: token.role,
      })),
      ...(reason ? { reason } : {}),
      checkedAt: new Date().toISOString(),
    }),
  );
});

/**
 * Price a swap without executing it.
 *
 * Quoting stops here by design. The result feeds the approval layer; nothing
 * on this path signs or broadcasts, and a route that must not be traded is
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

    const market = await getMarketQuote();
    const inputUsd = referenceUsd(inputSymbol, market);
    const outputUsd = referenceUsd(outputSymbol, market);

    const quote = await getSwapQuote({
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
