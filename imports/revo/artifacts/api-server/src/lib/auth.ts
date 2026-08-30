import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import {
  authNoncesTable,
  db,
  operatorSessionsTable,
  operatorsTable,
  treasuriesTable,
  type Operator,
} from "@workspace/db";
import { verifyMessage, type Hex } from "viem";
import { ARC_TESTNET_CHAIN_ID } from "./arc-chain";
import { auditSafe } from "./audit";

/**
 * Wallet-based operator authentication (SIWE-style, adapted to Arc Testnet).
 *
 * Flow: the browser requests a short-lived single-use nonce for an address,
 * the wallet signs the exact server-issued message, and the server verifies
 * the signature, consumes the nonce atomically, authorizes the wallet against
 * the operator registry, and issues a DB-backed session delivered as an
 * HttpOnly cookie. Only a SHA-256 hash of the session token is stored.
 */

export const ROLES = ["viewer", "strategist", "approver", "guardian", "admin"] as const;
export type OperatorRole = (typeof ROLES)[number];

export function isOperatorRole(value: unknown): value is OperatorRole {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

const NONCE_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
/** Window in which a session counts as "recently authenticated" for step-up. */
export const FRESH_AUTH_MS = 15 * 60_000;
export const SESSION_COOKIE = "revo_session";

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Browser origins allowed to talk to this API with credentials. Loaded from
 * APP_ORIGINS (comma-separated). Wildcard origins are never used with cookies.
 */
export function allowedOrigins(): string[] {
  const origins = new Set<string>();
  for (const raw of (process.env.APP_ORIGINS ?? "").split(",")) {
    const trimmed = raw.trim().replace(/\/$/, "");
    if (trimmed) origins.add(trimmed);
  }
  if (!isProd()) {
    origins.add("http://localhost");
    origins.add("http://127.0.0.1");
    origins.add("http://localhost:5173");
  }
  return [...origins];
}

function primaryOrigin(): string {
  const [first] = allowedOrigins();
  return first ?? "http://localhost";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function buildLoginMessage(address: string, nonce: string, issuedAt: string, expiresAt: string): string {
  const origin = primaryOrigin();
  const domain = new URL(origin).host;
  return [
    `${domain} wants you to sign in with your wallet:`,
    address,
    "",
    "Revo Treasury operator login (Arc Testnet). This signature proves wallet ownership only; it authorizes no transfers.",
    "",
    `URI: ${origin}`,
    `Chain ID: ${ARC_TESTNET_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`,
  ].join("\n");
}

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface IssuedChallenge {
  message: string;
  expiresAt: string;
}

export async function issueLoginNonce(addressRaw: string): Promise<IssuedChallenge> {
  const wallet = addressRaw.toLowerCase();
  if (!ADDRESS_RE.test(wallet)) throw new AuthError(400, "Invalid wallet address");

  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
  const message = buildLoginMessage(wallet, nonce, issuedAt.toISOString(), expiresAt.toISOString());

  await db.insert(authNoncesTable).values({
    id: `nonce-${randomUUID()}`,
    wallet,
    nonce,
    message,
    issuedAt,
    expiresAt,
  });

  // Opportunistic cleanup of expired nonces so the table cannot grow forever.
  await db
    .delete(authNoncesTable)
    .where(sql`${authNoncesTable.expiresAt} < now() - interval '1 hour'`);

  return { message, expiresAt: expiresAt.toISOString() };
}

export interface LoginResult {
  token: string;
  wallet: string;
  role: OperatorRole;
  treasuryId: string;
  sessionExpiresAt: string;
}

function ownerWallets(): Set<string> {
  return new Set(
    (process.env.OWNER_WALLET_ADDRESSES ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => ADDRESS_RE.test(entry)),
  );
}

/** The historical treasury id that pre-multi-tenant data lives under. */
export const FOUNDING_TREASURY_ID = "main";

function shortAddress(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}

/**
 * Authorizes a wallet AFTER its signature has been verified.
 *
 * Multi-tenant onboarding: a wallet already in the registry operates its
 * recorded treasury. A wallet in OWNER_WALLET_ADDRESSES attaches to the
 * founding treasury as admin. ANY other new wallet is onboarded automatically:
 * it gets its own freshly provisioned treasury and becomes its admin - no
 * wallet is ever locked out, and no wallet ever sees another tenant's data.
 */
async function authorizeOperator(wallet: string): Promise<Operator> {
  const [existing] = await db.select().from(operatorsTable).where(eq(operatorsTable.wallet, wallet));
  if (existing) return existing;

  const owners = ownerWallets();

  // The whole onboarding decision runs under the operator-roles advisory
  // lock: two concurrent first logins for the same wallet can never both
  // observe a missing row and each provision a treasury.
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('operator-roles'))`);
    const [row] = await tx
      .select()
      .from(operatorsTable)
      .where(eq(operatorsTable.wallet, wallet));
    if (row) return { operator: row, onboarded: false, reason: null as string | null };

    if (owners.has(wallet)) {
      await tx
        .insert(treasuriesTable)
        .values({ id: FOUNDING_TREASURY_ID, name: "Revo Treasury", ownerWallet: wallet })
        .onConflictDoNothing({ target: treasuriesTable.id });
      const [created] = await tx
        .insert(operatorsTable)
        .values({ wallet, treasuryId: FOUNDING_TREASURY_ID, role: "admin", addedBy: "owner-env" })
        .returning();
      return {
        operator: created ?? null,
        onboarded: true,
        reason: "listed in OWNER_WALLET_ADDRESSES; attached to founding treasury",
      };
    }

    // Reattach if this wallet already owns a treasury (e.g. its operator row
    // was removed); otherwise provision a brand-new one.
    const [owned] = await tx
      .select()
      .from(treasuriesTable)
      .where(eq(treasuriesTable.ownerWallet, wallet));
    let treasuryId = owned?.id ?? null;
    let reason = "reattached to previously owned treasury";
    if (!treasuryId) {
      treasuryId = `tr-${randomUUID()}`;
      await tx.insert(treasuriesTable).values({
        id: treasuryId,
        name: `Treasury ${shortAddress(wallet)}`,
        ownerWallet: wallet,
      });
      reason = "auto-onboarded with a freshly provisioned treasury";
    }
    const [created] = await tx
      .insert(operatorsTable)
      .values({ wallet, treasuryId, role: "admin", addedBy: "auto-onboard" })
      .returning();
    return { operator: created ?? null, onboarded: true, reason };
  });

  if (!outcome.operator) {
    throw new AuthError(403, "This wallet could not be onboarded. Please retry.");
  }
  if (outcome.onboarded) {
    await auditSafe({
      action: "operator.onboard",
      actorWallet: wallet,
      actorRole: outcome.operator.role,
      treasuryId: outcome.operator.treasuryId,
      result: "ok",
      reason: outcome.reason,
    });
  }
  return outcome.operator;
}

export async function verifyLogin(addressRaw: string, signature: string): Promise<LoginResult> {
  const wallet = addressRaw.toLowerCase();
  if (!ADDRESS_RE.test(wallet)) throw new AuthError(400, "Invalid wallet address");

  // Candidate nonces: unexpired, unconsumed, newest first. The signature
  // identifies which issued message was signed.
  const candidates = await db
    .select()
    .from(authNoncesTable)
    .where(
      and(
        eq(authNoncesTable.wallet, wallet),
        isNull(authNoncesTable.consumedAt),
        gt(authNoncesTable.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(authNoncesTable.issuedAt))
    .limit(3);

  let matched: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    let valid = false;
    try {
      valid = await verifyMessage({
        address: wallet as Hex,
        message: candidate.message,
        signature: signature as Hex,
      });
    } catch {
      valid = false;
    }
    if (valid) {
      matched = candidate;
      break;
    }
  }
  if (!matched) {
    throw new AuthError(401, "Signature verification failed. Request a fresh challenge and retry.");
  }

  // One-time consumption: the atomic claim guarantees a signed challenge can
  // never authenticate twice, even under concurrent verification attempts.
  const [consumed] = await db
    .update(authNoncesTable)
    .set({ consumedAt: new Date() })
    .where(and(eq(authNoncesTable.id, matched.id), isNull(authNoncesTable.consumedAt)))
    .returning();
  if (!consumed) {
    throw new AuthError(401, "This challenge was already used. Request a fresh one.");
  }

  const operator = await authorizeOperator(wallet);

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(operatorSessionsTable).values({
    id: `sess-${randomUUID()}`,
    tokenHash: hashToken(token),
    wallet,
    expiresAt,
  });

  return {
    token,
    wallet,
    role: operator.role as OperatorRole,
    treasuryId: operator.treasuryId,
    sessionExpiresAt: expiresAt.toISOString(),
  };
}

export async function revokeSessionByToken(token: string): Promise<void> {
  await db
    .update(operatorSessionsTable)
    .set({ revokedAt: new Date() })
    .where(eq(operatorSessionsTable.tokenHash, hashToken(token)));
}

export interface AuthContext {
  wallet: string;
  role: OperatorRole;
  /** The treasury this operator belongs to - the tenant for every query. */
  treasuryId: string;
  sessionId: string;
  sessionCreatedAt: Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      operator?: AuthContext;
    }
  }
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd(),
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: isProd(), path: "/" });
}

const LAST_SEEN_REFRESH_MS = 5 * 60_000;

/** Resolves the session cookie (if any) into `req.operator`. Never rejects. */
export const attachOperator: RequestHandler = async (req, _res, next) => {
  try {
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) {
      next();
      return;
    }
    const [row] = await db
      .select({
        sessionId: operatorSessionsTable.id,
        createdAt: operatorSessionsTable.createdAt,
        lastSeenAt: operatorSessionsTable.lastSeenAt,
        wallet: operatorSessionsTable.wallet,
        role: operatorsTable.role,
        treasuryId: operatorsTable.treasuryId,
      })
      .from(operatorSessionsTable)
      .innerJoin(operatorsTable, eq(operatorsTable.wallet, operatorSessionsTable.wallet))
      .where(
        and(
          eq(operatorSessionsTable.tokenHash, hashToken(token)),
          isNull(operatorSessionsTable.revokedAt),
          gt(operatorSessionsTable.expiresAt, new Date()),
        ),
      );
    if (row && isOperatorRole(row.role)) {
      req.operator = {
        wallet: row.wallet,
        role: row.role,
        treasuryId: row.treasuryId,
        sessionId: row.sessionId,
        sessionCreatedAt: row.createdAt,
      };
      if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS) {
        // Fire-and-forget: liveness metadata must not block the request.
        db.update(operatorSessionsTable)
          .set({ lastSeenAt: new Date() })
          .where(eq(operatorSessionsTable.id, row.sessionId))
          .catch(() => {});
      }
    }
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Requires an authenticated operator; when `roles` is given, the operator's
 * role must be in the set (admin always qualifies). Authorization is enforced
 * here on the server - frontend visibility is never security.
 */
export function requireOperator(roles?: OperatorRole[]): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.operator) {
      res.status(401).json({ error: "Sign in with an operator wallet to perform this action." });
      return;
    }
    if (roles && roles.length > 0 && req.operator.role !== "admin" && !roles.includes(req.operator.role)) {
      res.status(403).json({
        error: `Your role (${req.operator.role}) is not allowed to perform this action.`,
      });
      return;
    }
    next();
  };
}

/**
 * Step-up check for sensitive changes (role changes, limit changes, pause
 * deactivation, enabling auto-execution): the session must have been created
 * by a signature within the freshness window.
 */
export const requireFreshAuth: RequestHandler = (req, res, next) => {
  if (!req.operator) {
    res.status(401).json({ error: "Sign in with an operator wallet to perform this action." });
    return;
  }
  if (Date.now() - req.operator.sessionCreatedAt.getTime() > FRESH_AUTH_MS) {
    res.status(401).json({
      error: "This sensitive change requires a recent sign-in. Sign in again and retry.",
      code: "stale_session",
    });
    return;
  }
  next();
};

/**
 * CSRF defense-in-depth on top of SameSite=Lax cookies: a state-changing
 * request that carries a session cookie and a browser Origin header must
 * come from an allowed origin.
 */
export const originGuard: RequestHandler = (req, res, next) => {
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (!mutating) {
    next();
    return;
  }
  const hasSession = Boolean((req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE]);
  const origin = req.headers.origin;
  if (hasSession && typeof origin === "string" && !allowedOrigins().includes(origin.replace(/\/$/, ""))) {
    res.status(403).json({ error: "Cross-origin request rejected." });
    return;
  }
  next();
};
