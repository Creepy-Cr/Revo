import { Router, type IRouter } from "express";
import { GetChainParamsResponse } from "@workspace/api-zod";
import { getChainStatus } from "../lib/chain";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID_HEX,
  ARC_TESTNET_CHAIN_NAME,
  ARC_RPC_URL,
  EXPLORER_URL,
  FAUCET_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
} from "../lib/arc-chain";

const router: IRouter = Router();

router.get("/chain/status", async (_req, res, next) => {
  try {
    const status = await getChainStatus();
    res.json(status);
  } catch (error) {
    next(error);
  }
});

/**
 * Public chain parameters. The access gate needs these BEFORE sign-in to
 * detect a wrong network and offer the switch/add-chain prompt - they are
 * global Arc Testnet facts, never tenant data (the per-treasury custody
 * address stays behind auth on GET /treasury/wallet).
 */
router.get("/chain/params", (_req, res) => {
  res.json(
    GetChainParamsResponse.parse({
      chainId: ARC_TESTNET_CHAIN_ID,
      chainIdHex: ARC_TESTNET_CHAIN_ID_HEX,
      chainName: ARC_TESTNET_CHAIN_NAME,
      rpcUrl: ARC_RPC_URL,
      usdcAddress: USDC_ADDRESS,
      usdcDecimals: USDC_DECIMALS,
      explorerUrl: EXPLORER_URL,
      faucetUrl: FAUCET_URL,
    }),
  );
});

export default router;
