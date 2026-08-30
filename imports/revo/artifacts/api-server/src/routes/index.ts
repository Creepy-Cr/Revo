import { Router, type IRouter } from "express";
import healthRouter from "./health";
import treasuryRouter from "./treasury";
import chainRouter from "./chain";
import treasuryWalletRouter from "./treasury-wallet";
import authRouter from "./auth";
import securityRouter from "./security";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(securityRouter);
router.use(treasuryWalletRouter);
router.use(treasuryRouter);
router.use(chainRouter);

export default router;
