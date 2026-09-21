import { and, eq, gt, sql } from "drizzle-orm";
import { parseAbi, type Address, type PublicClient } from "viem";
import { auditEventsTable, db } from "@workspace/db";
import { arcPublicClient, ChainError, type CustodyTransaction } from "./arc-chain";
import { logger } from "./logger";

const issuerAbi = parseAbi([
  "function paused() view returns (bool)",
  "function isBlacklisted(address account) view returns (bool)",
]);

/**
 * A cap that cannot be parsed is a configuration fault, not a missing cap:
 * `Number("bad")` is NaN and would pass every "greater than" comparison, so
 * the process refuses to start rather than run with the limits switched off.
 */
function readUsdCap(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite USD amount; got "${raw}".`);
  }
  return value;
}

export const MAX_REBALANCE_USD_PER_TRADE = readUsdCap("REBALANCE_MAX_USD_PER_TRADE", 25_000);
export const MAX_REBALANCE_USD_PER_DAY = readUsdCap("REBALANCE_MAX_USD_PER_DAY", 100_000);
if (MAX_REBALANCE_USD_PER_DAY < MAX_REBALANCE_USD_PER_TRADE) {
  throw new Error(
    "REBALANCE_MAX_USD_PER_DAY must be at least REBALANCE_MAX_USD_PER_TRADE; otherwise no single trade could ever clear the daily limit.",
  );
}
export const MAX_MARKET_QUOTE_AGE_MS = 10 * 60_000;

export interface IssuerStatus {
  tokenPaused: boolean;
  walletBlacklisted: boolean;
  destinationBlacklisted: boolean;
}

/**
 * Reads Circle's controls afresh. No issuer decision is cached, and a read
 * that fails is reported as an RPC failure rather than as an answer: an
 * unreachable node never counts as "allowed" and never counts as "blocked".
 */
export async function isBlockedByIssuer(
  token: Address,
  wallet: Address,
  destination?: Address,
  client: PublicClient = arcPublicClient(),
): Promise<IssuerStatus> {
  try {
    const [tokenPaused, walletBlacklisted, destinationBlacklisted] = await Promise.all([
      client.readContract({ address: token, abi: issuerAbi, functionName: "paused" }),
      client.readContract({
        address: token,
        abi: issuerAbi,
        functionName: "isBlacklisted",
        args: [wallet],
      }),
      destination
        ? client.readContract({
            address: token,
            abi: issuerAbi,
            functionName: "isBlacklisted",
            args: [destination],
          })
        : Promise.resolve(false),
    ]);
    return {
      tokenPaused: tokenPaused as boolean,
      walletBlacklisted: walletBlacklisted as boolean,
      destinationBlacklisted: destinationBlacklisted as boolean,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : String(error);
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `The token issuer's controls could not be read from Arc, so the operation was not signed: ${detail}`,
    );
  }
}

/**
 * Refuses when the issuer would reject the transfer. Throws
 * REFUSED_BY_POLICY for a real block and RPC_UNAVAILABLE when the answer
 * could not be obtained; callers must treat only the former as terminal.
 */
export async function assertIssuerAllows(
  token: Address,
  wallet: Address,
  destination?: Address,
): Promise<void> {
  const status = await isBlockedByIssuer(token, wallet, destination);
  let reason: string | null = null;
  if (status.tokenPaused) reason = "The token issuer has paused this token.";
  else if (status.walletBlacklisted) reason = "The token issuer has blocked the custody wallet.";
  else if (status.destinationBlacklisted) {
    reason = "The token issuer has blocked the withdrawal destination.";
  }
  if (reason) {
    logger.error({ token, wallet, destination, status }, "Custody send refused by issuer policy");
    throw new ChainError("REFUSED_BY_POLICY", `${reason} Nothing was signed or sent.`);
  }
}

export function assertFreshMarketQuote(quote: { stale: boolean; fetchedAt: number } | null): void {
  if (!quote) {
    throw new ChainError(
      "REFUSED_BY_POLICY",
      "A current independent market price is required before a rebalance can be signed.",
    );
  }
  if (quote.stale || Date.now() - quote.fetchedAt > MAX_MARKET_QUOTE_AGE_MS) {
    throw new ChainError(
      "REFUSED_BY_POLICY",
      "The independent market price is stale or more than 10 minutes old, so the rebalance was not signed.",
    );
  }
}

export function rebalanceCapReason(tradeUsd: number, prior24hUsd: number): string | null {
  if (!Number.isFinite(tradeUsd) || tradeUsd < 0) {
    return "The rebalance USD value could not be established.";
  }
  if (tradeUsd > MAX_REBALANCE_USD_PER_TRADE) {
    return `This rebalance exceeds the per-trade limit of ${MAX_REBALANCE_USD_PER_TRADE.toLocaleString("en-US")} USD.`;
  }
  if (prior24hUsd + tradeUsd > MAX_REBALANCE_USD_PER_DAY) {
    return `This rebalance would exceed the treasury's rolling 24h limit of ${MAX_REBALANCE_USD_PER_DAY.toLocaleString("en-US")} USD.`;
  }
  return null;
}

/** Audit action written once a swap is signed and claimed, before broadcast. */
export const REBALANCE_SIGNED_AUDIT_ACTION = "custody.rebalance.signed";

/**
 * Enforces absolute USD limits while the caller holds the treasury custody
 * lock. The 24h total counts every swap that reached signing, recorded in the
 * append-only, hash-chained audit log before broadcast: a swap whose receipt
 * is still unknown has committed its value and must count, and operators
 * cannot revise that log through application APIs.
 */
export async function assertRebalanceCaps(
  treasuryId: string,
  tradeUsd: number,
  executor: CustodyTransaction | typeof db = db,
): Promise<void> {
  const immediateReason = rebalanceCapReason(tradeUsd, 0);
  if (
    immediateReason &&
    (!Number.isFinite(tradeUsd) ||
      tradeUsd < 0 ||
      tradeUsd > MAX_REBALANCE_USD_PER_TRADE ||
      tradeUsd > MAX_REBALANCE_USD_PER_DAY)
  ) {
    throw new ChainError("REFUSED_BY_POLICY", immediateReason);
  }
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [row] = await executor
    .select({
      total: sql<number>`coalesce(sum((${auditEventsTable.detail}->>'tradeUsd')::double precision), 0)::double precision`,
    })
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.treasuryId, treasuryId),
        eq(auditEventsTable.action, REBALANCE_SIGNED_AUDIT_ACTION),
        eq(auditEventsTable.result, "ok"),
        gt(auditEventsTable.time, since),
      ),
    );
  const used = row?.total ?? 0;
  const reason = rebalanceCapReason(tradeUsd, used);
  if (reason) throw new ChainError("REFUSED_BY_POLICY", reason);
}