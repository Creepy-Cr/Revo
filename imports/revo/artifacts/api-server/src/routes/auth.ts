import { Router, type IRouter } from "express";
import {
  GetAuthSessionResponse,
  RequestAuthNonceBody,
  RequestAuthNonceResponse,
  VerifyAuthSignatureBody,
  VerifyAuthSignatureResponse,
} from "@workspace/api-zod";
import { db, treasuriesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { auditSafe } from "../lib/audit";
import {
  AuthError,
  SESSION_COOKIE,
  clearSessionCookie,
  issueLoginNonce,
  revokeSessionByToken,
  setSessionCookie,
  verifyLogin,
} from "../lib/auth";
import { llmGuard } from "../lib/llm-guard";

const router: IRouter = Router();

// Auth endpoints are public by necessity - keep them tightly rate-limited.
const nonceGuard = llmGuard({
  scope: "login challenge",
  windowMs: 60_000,
  maxPerWindow: 10,
  maxConcurrent: 4,
});
const verifyGuard = llmGuard({
  scope: "login verification",
  windowMs: 60_000,
  maxPerWindow: 5,
  maxConcurrent: 4,
});

router.post("/auth/nonce", nonceGuard, async (req, res): Promise<void> => {
  const parsed = RequestAuthNonceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A wallet address is required" });
    return;
  }
  try {
    const challenge = await issueLoginNonce(parsed.data.address);
    res.status(201).json(RequestAuthNonceResponse.parse(challenge));
  } catch (error) {
    if (error instanceof AuthError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/auth/verify", verifyGuard, async (req, res): Promise<void> => {
  const parsed = VerifyAuthSignatureBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A wallet address and signature are required" });
    return;
  }
  try {
    const login = await verifyLogin(parsed.data.address, parsed.data.signature);
    setSessionCookie(res, login.token);
    await auditSafe({
      action: "auth.login",
      actorWallet: login.wallet,
      actorRole: login.role,
      treasuryId: login.treasuryId,
      requestId: req.id ? String(req.id) : null,
      result: "ok",
    });
    res.json(
      VerifyAuthSignatureResponse.parse({
        wallet: login.wallet,
        role: login.role,
        treasuryId: login.treasuryId,
        sessionExpiresAt: login.sessionExpiresAt,
      }),
    );
  } catch (error) {
    if (error instanceof AuthError) {
      // Denied logins are audit-worthy security events (signature failures
      // and unauthorized wallets), but never leak which case occurred beyond
      // the response message itself.
      await auditSafe({
        action: "auth.login",
        actorWallet: parsed.data.address.toLowerCase(),
        result: "denied",
        reason: error.status === 403 ? "wallet not an operator" : "verification failed",
      });
      res.status(error.status).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (token) {
    await revokeSessionByToken(token);
    if (req.operator) {
      await auditSafe({
        action: "auth.logout",
        actorWallet: req.operator.wallet,
        actorRole: req.operator.role,
        treasuryId: req.operator.treasuryId,
        sessionId: req.operator.sessionId,
        result: "ok",
      });
    }
  }
  clearSessionCookie(res);
  res.status(204).end();
});

router.get("/auth/me", async (req, res): Promise<void> => {
  if (!req.operator) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const operator = req.operator;
  const [treasury] = await db
    .select({ name: treasuriesTable.name })
    .from(treasuriesTable)
    .where(eq(treasuriesTable.id, operator.treasuryId));
  if (!treasury) {
    res.status(503).json({ error: "The operator's treasury is unavailable." });
    return;
  }
  res.json(
    GetAuthSessionResponse.parse({
      wallet: operator.wallet,
      role: operator.role,
      treasuryId: operator.treasuryId,
      treasuryName: treasury.name,
      sessionCreatedAt: operator.sessionCreatedAt.toISOString(),
    }),
  );
});

export default router;
