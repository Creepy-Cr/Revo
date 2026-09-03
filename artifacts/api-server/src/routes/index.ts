import { Router, type IRouter } from "express";
import healthRouter from "./health";
import treasuryRouter from "./treasury";
import chainRouter from "./chain";
import treasuryWalletRouter from "./treasury-wallet";
import treasuryCrosschainRouter from "./treasury-crosschain";
import authRouter from "./auth";
import securityRouter from "./security";

const router: IRouter = Router();

// Artifact deployments probe the service mount path before promotion.
router.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "revo-treasury-api" });
});

router.use(healthRouter);
router.use(authRouter);
router.use(securityRouter);
router.use(treasuryWalletRouter);
router.use(treasuryCrosschainRouter);
router.use(treasuryRouter);
router.use(chainRouter);

export default router;
