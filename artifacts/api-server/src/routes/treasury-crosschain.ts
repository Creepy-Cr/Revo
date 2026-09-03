import { Router, type IRouter } from "express";
import { GetTreasuryCrosschainBalanceResponse } from "@workspace/api-zod";
import { ensureTreasuryWallet } from "../lib/arc-chain";
import { requireOperator } from "../lib/auth";
import { readCrosschainBalance } from "../lib/appkit";

const router: IRouter = Router();

/**
 * Cross-chain view of the treasury, read from Circle Gateway through App Kit.
 *
 * Deliberately read-only: it reports where the treasury's Gateway-deposited
 * USDC sits and never moves it. The treasury is resolved from the session, so
 * an operator can only ever read their own treasury's figures.
 */
router.get("/treasury/crosschain", requireOperator(), async (req, res): Promise<void> => {
  const wallet = await ensureTreasuryWallet(req.operator!.treasuryId);
  const reading = await readCrosschainBalance(wallet.address);
  if (!reading.available) {
    req.log.warn(
      { address: wallet.address, reason: reading.error },
      "Circle Gateway balance unavailable",
    );
  }
  res.json(GetTreasuryCrosschainBalanceResponse.parse(reading));
});

export default router;
