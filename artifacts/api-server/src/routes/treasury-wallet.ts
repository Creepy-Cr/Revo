import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  ClaimTreasuryDepositBody,
  ClaimTreasuryDepositResponse,
  GetTreasuryWalletInfoResponse,
  GetTreasuryWalletPositionResponse,
  RequestTreasuryWithdrawalBody,
  RequestTreasuryWithdrawalResponse,
} from "@workspace/api-zod";
import {
  db,
  onchainTransfersTable,
  treasuryStateTable,
  type OnchainTransfer,
} from "@workspace/db";
import { formatUnits, verifyMessage, type Hex } from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_CHAIN_ID_HEX,
  ARC_TESTNET_CHAIN_NAME,
  ARC_RPC_URL,
  ChainError,
  EXPLORER_URL,
  FAUCET_URL,
  USDC_ADDRESS,
  USDC_DECIMALS,
  broadcastSignedTransfer,
  confirmTransfer,
  ensureTreasuryWallet,
  fromMicroUsdc,
  getTransferRecoveryStatus,
  signUsdcTransfer,
  toMicroUsdc,
  verifyDeposit,
  withCustodyLock,
  withdrawalAuthMessage,
  type SignedTransfer,
} from "../lib/arc-chain";
import { openRecoveryPayload, sealRecoveryPayload } from "../lib/custody-crypto";
import { auditSafe } from "../lib/audit";
import { raiseAlert } from "../lib/alerts";
import { requireOperator } from "../lib/auth";
import { logger } from "../lib/logger";
import {
  checkWithdrawalCaps,
  checkWithdrawalHalt,
  treasuryTransitionLock,
} from "../lib/security-controls";
import { loadState, logActivity } from "../lib/state";

const router: IRouter = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Same advisory lock as policy/proposal transitions (see routes/treasury.ts):
 * deposits, withdrawals, and rebalances all mutate the treasury's USDC units,
 * so they must be strictly ordered against each other.
 */
async function lockTreasuryTransitions(tx: Tx, treasuryId: string): Promise<void> {
  await tx.execute(treasuryTransitionLock(treasuryId));
}

function serializeTransfer(transfer: OnchainTransfer) {
  return {
    id: transfer.id,
    direction: transfer.direction,
    wallet: transfer.wallet,
    amountUsdc: transfer.amountUsdc,
    txHash: transfer.txHash,
    status: transfer.status,
    explorerTxUrl: transfer.txHash ? `${EXPLORER_URL}/tx/${transfer.txHash}` : null,
    createdAt: transfer.createdAt.toISOString(),
    confirmedAt: transfer.confirmedAt ? transfer.confirmedAt.toISOString() : null,
  };
}

function chainErrorStatus(error: ChainError): number {
  switch (error.code) {
    case "TX_NOT_FOUND":
      return 404;
    case "NOT_A_DEPOSIT":
    case "TX_REVERTED":
      return 400;
    default:
      return 502;
  }
}

function publicChainError(error: ChainError): string {
  switch (error.code) {
    case "TX_NOT_FOUND":
      return "That transaction is not on Arc Testnet yet. Wait for confirmation, then retry.";
    case "TX_REVERTED":
      return "The Arc Testnet transaction reverted.";
    case "NOT_A_DEPOSIT":
      return "That transaction is not a valid testnet USDC deposit to this treasury.";
    case "WRONG_CHAIN":
      return "The configured RPC is not serving Arc Testnet. The operation was refused.";
    case "SEND_UNCERTAIN":
      return "The Arc Testnet RPC did not return a definitive broadcast result.";
    case "SEND_FAILED":
      return "Arc Testnet rejected the withdrawal before it was broadcast.";
    case "SIMULATION_REVERTED":
      return "The transaction reverted when simulated, so it was never signed.";
    case "RPC_UNAVAILABLE":
      return "Arc Testnet RPC is temporarily unavailable.";
  }
}

/**
 * Net withdrawable balance for a wallet: confirmed deposits minus confirmed
 * AND pending withdrawals (pending withdrawals have already reserved units).
 */
async function netDepositedMicro(
  executor: Tx | typeof db,
  treasuryId: string,
  wallet: string,
): Promise<bigint> {
  const rows = await executor
    .select()
    .from(onchainTransfersTable)
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, treasuryId),
        eq(onchainTransfersTable.wallet, wallet),
      ),
    );
  let net = 0n;
  for (const row of rows) {
    const micro = toMicroUsdc(row.amountUsdc);
    if (row.direction === "deposit" && row.status === "confirmed") net += micro;
    if (row.direction === "withdrawal" && row.status !== "failed") net -= micro;
  }
  return net;
}

router.get("/treasury/wallet", requireOperator(), async (req, res): Promise<void> => {
  const wallet = await ensureTreasuryWallet(req.operator!.treasuryId);
  res.json(
    GetTreasuryWalletInfoResponse.parse({
      treasuryAddress: wallet.address,
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

/** How long a pending withdrawal must be stale before we probe the chain. */
const RECONCILE_MIN_AGE_MS = 15_000;

/**
 * How long a pending withdrawal may sit WITHOUT a transaction hash before it
 * is refunded as never-broadcast. The hash is always persisted (commit) before
 * any broadcast, so a null hash proves nothing reached the mempool - this
 * window only exists so we never race a live request that is still between
 * reservation and hash persistence (that path also re-checks the row is still
 * pending before broadcasting, closing the race completely).
 */
const NO_HASH_REFUND_AGE_MS = 5 * 60_000;
const REBROADCAST_MIN_AGE_MS = 30_000;
const MAX_BROADCAST_ATTEMPTS = 3;

/**
 * Resolves pending withdrawals whose broadcast/confirmation outcome was
 * unobservable at request time.
 * - Rows WITH a hash: only a definitive on-chain receipt changes anything -
 *   success → confirmed, revert → failed + refund.
 * - Rows WITHOUT a hash (crash/DB failure before broadcast): provably never
 *   broadcast, refunded once stale.
 * Status-guarded updates make this safe against a concurrent request
 * resolving the same row.
 */
export async function reconcilePendingWithdrawals(
  treasuryId: string,
  address?: string,
  workerSignal?: AbortSignal,
): Promise<void> {
  const assertWorkerFence = () => workerSignal?.throwIfAborted();
  const conditions = [
    eq(onchainTransfersTable.treasuryId, treasuryId),
    eq(onchainTransfersTable.direction, "withdrawal"),
    eq(onchainTransfersTable.status, "pending"),
  ];
  if (address) conditions.push(eq(onchainTransfersTable.wallet, address));
  const rows = await db
    .select()
    .from(onchainTransfersTable)
    .where(and(...conditions));

  for (const row of rows) {
    const ageMs = Date.now() - row.createdAt.getTime();

    let resolution: "confirmed" | "failed";
    if (row.txHash) {
      if (ageMs < RECONCILE_MIN_AGE_MS) continue;
      const outcome = await getTransferRecoveryStatus(row.txHash as Hex);
      if (outcome === "pending" || outcome === "unknown") continue;
      if (outcome === "missing") {
        if (row.recoveryState === "manual_review") continue;
        const lastAttemptAge = row.lastBroadcastAt
          ? Date.now() - row.lastBroadcastAt.getTime()
          : ageMs;
        if (lastAttemptAge < REBROADCAST_MIN_AGE_MS) continue;

        let manualReviewReason: "attempts_exhausted" | "payload_unavailable" | null = null;
        try {
          assertWorkerFence();
          await withCustodyLock(treasuryId, async (custodyTx) => {
            const [current] = await custodyTx
              .select()
              .from(onchainTransfersTable)
              .where(
                and(
                  eq(onchainTransfersTable.treasuryId, treasuryId),
                  eq(onchainTransfersTable.id, row.id),
                  eq(onchainTransfersTable.status, "pending"),
                ),
              );
            if (!current || current.recoveryState === "manual_review") return;
            if (!current.signedPayload || current.broadcastAttempts >= MAX_BROADCAST_ATTEMPTS) {
              assertWorkerFence();
              const [flagged] = await custodyTx
                .update(onchainTransfersTable)
                .set({ recoveryState: "manual_review" })
                .where(
                  and(
                    eq(onchainTransfersTable.treasuryId, treasuryId),
                    eq(onchainTransfersTable.id, current.id),
                    eq(onchainTransfersTable.status, "pending"),
                    sql`${onchainTransfersTable.recoveryState} IS DISTINCT FROM 'manual_review'`,
                  ),
                )
                .returning();
              if (flagged) {
                manualReviewReason = current.signedPayload
                  ? "attempts_exhausted"
                  : "payload_unavailable";
              }
              return;
            }
            let serialized: Hex;
            try {
              serialized = openRecoveryPayload(current.signedPayload);
            } catch {
              assertWorkerFence();
              const [flagged] = await custodyTx
                .update(onchainTransfersTable)
                .set({ recoveryState: "manual_review" })
                .where(
                  and(
                    eq(onchainTransfersTable.treasuryId, treasuryId),
                    eq(onchainTransfersTable.id, current.id),
                    eq(onchainTransfersTable.status, "pending"),
                    sql`${onchainTransfersTable.recoveryState} IS DISTINCT FROM 'manual_review'`,
                  ),
                )
                .returning();
              if (flagged) manualReviewReason = "payload_unavailable";
              return;
            }
            assertWorkerFence();
            const [claimed] = await custodyTx
              .update(onchainTransfersTable)
              .set({
                broadcastAttempts: current.broadcastAttempts + 1,
                lastBroadcastAt: new Date(),
                recoveryState: "retrying",
              })
              .where(
                and(
                  eq(onchainTransfersTable.treasuryId, treasuryId),
                  eq(onchainTransfersTable.id, current.id),
                  eq(onchainTransfersTable.status, "pending"),
                  eq(onchainTransfersTable.broadcastAttempts, current.broadcastAttempts),
                ),
              )
              .returning();
            if (!claimed) return;
            assertWorkerFence();
            await broadcastSignedTransfer({
              hash: current.txHash as Hex,
              serialized,
              nonce: current.txNonce ?? 0,
            });
          });
        } catch (error) {
          logger.warn(
            { err: error, treasuryId, transferId: row.id, txHash: row.txHash },
            "Identical withdrawal rebroadcast did not resolve",
          );
        }
        if (manualReviewReason) {
          assertWorkerFence();
          await raiseAlert({
            treasuryId,
            severity: "critical",
            kind: "withdrawal.manual-review",
            title:
              manualReviewReason === "attempts_exhausted"
                ? "Withdrawal requires manual review"
                : "Withdrawal recovery payload unavailable",
            detail:
              manualReviewReason === "attempts_exhausted"
                ? "A testnet withdrawal remains unconfirmed after bounded identical rebroadcast attempts. Its reservation remains held; operator review is required."
                : "A pending testnet withdrawal cannot be safely rebroadcast. Its reservation remains held; operator review is required.",
            data: { transferId: row.id, txHash: row.txHash, attempts: row.broadcastAttempts },
          });
        }
        continue;
      }
      resolution = outcome === "success" ? "confirmed" : "failed";
    } else {
      // Hash persistence always precedes broadcast, so a stale null-hash row
      // was definitively never sent - refund it.
      if (ageMs < NO_HASH_REFUND_AGE_MS) continue;
      resolution = "failed";
    }

    assertWorkerFence();
    await db.transaction(async (tx) => {
      await lockTreasuryTransitions(tx, treasuryId);
      assertWorkerFence();
      const [claimed] = await tx
        .update(onchainTransfersTable)
        .set(
          resolution === "confirmed"
            ? { status: "confirmed", confirmedAt: new Date() }
            : { status: "failed" },
        )
        .where(
          and(
            eq(onchainTransfersTable.treasuryId, treasuryId),
            eq(onchainTransfersTable.id, row.id),
            eq(onchainTransfersTable.status, "pending"),
          ),
        )
        .returning();
      if (claimed && resolution === "failed") {
        assertWorkerFence();
        await tx
          .update(treasuryStateTable)
          .set({
            usdcUnits: sql`${treasuryStateTable.usdcUnits} + ${row.amountUsdc}`,
            updatedAt: new Date(),
          })
          .where(eq(treasuryStateTable.id, treasuryId));
      }
    });
  }
}

router.get(
  "/treasury/wallet/:address/position",
  requireOperator(),
  async (req, res): Promise<void> => {
  const treasuryId = req.operator!.treasuryId;
  const address = String(req.params.address).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  await reconcilePendingWithdrawals(treasuryId, address);

  const transfers = await db
    .select()
    .from(onchainTransfersTable)
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, treasuryId),
        eq(onchainTransfersTable.wallet, address),
      ),
    )
    .orderBy(desc(onchainTransfersTable.createdAt));
  const net = await netDepositedMicro(db, treasuryId, address);

  res.json(
    GetTreasuryWalletPositionResponse.parse({
      address,
      netDepositedUsdc: fromMicroUsdc(net > 0n ? net : 0n),
      transfers: transfers.map(serializeTransfer),
    }),
  );
});

router.post("/treasury/wallet/deposits", requireOperator(), async (req, res): Promise<void> => {
  const parsed = ClaimTreasuryDepositBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid transaction hash (0x…, 64 hex chars) is required" });
    return;
  }
  const txHash = parsed.data.txHash.toLowerCase() as Hex;
  const treasuryId = req.operator!.treasuryId;

  const wallet = await ensureTreasuryWallet(treasuryId);

  // Treasury state must exist before we can credit units to it.
  try {
    await loadState(treasuryId);
  } catch (error) {
    req.log.error({ err: error, treasuryId }, "Treasury state load failed");
    res.status(503).json({ error: "Treasury state is temporarily unavailable." });
    return;
  }

  let deposit;
  try {
    deposit = await verifyDeposit(txHash, wallet.address);
  } catch (error) {
    if (error instanceof ChainError) {
      req.log.warn({ txHash, code: error.code, err: error }, "Deposit claim rejected");
      res.status(chainErrorStatus(error)).json({ error: publicChainError(error) });
      return;
    }
    throw error;
  }

  const amountUsdc = fromMicroUsdc(deposit.microUsdc);

  // Atomic credit: the unique txHash insert and the units credit commit
  // together under the transition lock, so a transaction can never be
  // credited twice and never races a rebalance.
  const credited = await db.transaction(async (tx) => {
    await lockTreasuryTransitions(tx, treasuryId);
    const [row] = await tx
      .insert(onchainTransfersTable)
      .values({
        id: `xfer-${randomUUID()}`,
        treasuryId,
        direction: "deposit",
        wallet: deposit.from,
        amountUsdc,
        txHash,
        status: "confirmed",
        confirmedAt: new Date(),
      })
      .onConflictDoNothing({ target: onchainTransfersTable.txHash })
      .returning();
    if (!row) return null;

    await tx
      .update(treasuryStateTable)
      .set({
        usdcUnits: sql`${treasuryStateTable.usdcUnits} + ${amountUsdc}`,
        updatedAt: new Date(),
      })
      .where(eq(treasuryStateTable.id, treasuryId));
    return row;
  });

  if (!credited) {
    res.status(409).json({ error: "That transaction has already been credited to the treasury" });
    return;
  }

  await logActivity(
    treasuryId,
    "On-chain deposit received",
    `${amountUsdc.toLocaleString("en-US", { maximumFractionDigits: 6 })} testnet USDC deposited from ${deposit.from} (verified on Arc Testnet, tx ${txHash.slice(0, 10)}…). Credited to the liquid reserve.`,
    "executed",
    "onchain",
  );
  await auditSafe({
    treasuryId,
    action: "wallet.deposit.claim",
    actorWallet: req.operator!.wallet,
    actorRole: req.operator!.role,
    sessionId: req.operator!.sessionId,
    resourceId: credited.id,
    result: "ok",
    detail: { txHash, amountUsdc, from: deposit.from },
  });
  req.log.info({ txHash, amountUsdc, from: deposit.from }, "On-chain deposit credited");
  res.status(201).json(ClaimTreasuryDepositResponse.parse(serializeTransfer(credited)));
});

router.post("/treasury/wallet/withdrawals", requireOperator(), async (req, res): Promise<void> => {
  const parsed = RequestTreasuryWithdrawalBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        "A valid destination address, a positive USDC amount, and a signed authorization (issuedAt + signature) are required",
    });
    return;
  }
  const address = parsed.data.address.toLowerCase();
  const treasuryId = req.operator!.treasuryId;
  const microUsdc = toMicroUsdc(parsed.data.amountUsdc);
  if (microUsdc <= 0n) {
    res.status(400).json({ error: "Withdrawal amount is below the minimum of 0.000001 USDC" });
    return;
  }
  const amountUsdc = fromMicroUsdc(microUsdc);

  // Authorization: only the destination wallet itself may trigger a
  // withdrawal of its balance. It proves ownership with a fresh EIP-191
  // signature over the exact amount + destination + timestamp.
  const { issuedAt, signature } = parsed.data;
  const issuedAtMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedAtMs) || Math.abs(Date.now() - issuedAtMs) > 5 * 60_000) {
    res.status(400).json({
      error: "The withdrawal authorization has expired (valid for 5 minutes). Sign a fresh one and retry.",
    });
    return;
  }
  const authMessage = withdrawalAuthMessage(
    address,
    formatUnits(microUsdc, USDC_DECIMALS),
    issuedAt,
  );
  let signatureValid = false;
  try {
    signatureValid = await verifyMessage({
      address: address as Hex,
      message: authMessage,
      signature: signature as Hex,
    });
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    res.status(401).json({
      error: "Signature verification failed. Withdrawals must be signed by the destination wallet itself.",
    });
    return;
  }

  const wallet = await ensureTreasuryWallet(treasuryId);
  try {
    await loadState(treasuryId);
  } catch (error) {
    req.log.error({ err: error, treasuryId }, "Treasury state load failed");
    res.status(503).json({ error: "Treasury state is temporarily unavailable." });
    return;
  }

  // Phase 1 - atomically reserve: check the depositor's withdrawable balance
  // and the treasury's liquid reserve, debit the units, and record a pending
  // ledger row, all under the transition lock.
  const reservation = await db.transaction(async (tx) => {
    await lockTreasuryTransitions(tx, treasuryId);

    const [unresolved] = await tx
      .select({ id: onchainTransfersTable.id })
      .from(onchainTransfersTable)
      .where(
        and(
          eq(onchainTransfersTable.treasuryId, treasuryId),
          eq(onchainTransfersTable.direction, "withdrawal"),
          eq(onchainTransfersTable.status, "pending"),
        ),
      )
      .limit(1);
    if (unresolved) {
      return {
        kind: "rejected" as const,
        error:
          "A prior treasury withdrawal is still being confirmed or recovered. Retry after it resolves.",
      };
    }

    // Emergency pause and persisted outflow caps are enforced inside the
    // reservation transaction (under the transition lock), so concurrent
    // withdrawals cannot jointly exceed a limit.
    const capError = await checkWithdrawalCaps(tx, treasuryId, address, amountUsdc);
    if (capError) {
      return { kind: "rejected" as const, error: capError };
    }

    const net = await netDepositedMicro(tx, treasuryId, address);
    if (microUsdc > net) {
      return {
        kind: "rejected" as const,
        error: `This wallet's withdrawable balance is ${fromMicroUsdc(net > 0n ? net : 0n).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC. It can only withdraw what it deposited.`,
      };
    }

    const [state] = await tx
      .select()
      .from(treasuryStateTable)
      .where(eq(treasuryStateTable.id, treasuryId));
    if (!state || state.usdcUnits < amountUsdc) {
      return {
        kind: "rejected" as const,
        error:
          "The treasury's liquid USDC reserve is currently below the requested amount. Try a smaller amount or wait for a rebalance into the liquid reserve.",
      };
    }

    // Insert before debiting: a replayed authorization signature conflicts
    // here (unique column) and must not touch the treasury units.
    const [row] = await tx
      .insert(onchainTransfersTable)
      .values({
        id: `xfer-${randomUUID()}`,
        treasuryId,
        direction: "withdrawal",
        wallet: address,
        amountUsdc,
        status: "pending",
        authSignature: signature.toLowerCase(),
      })
      .onConflictDoNothing({ target: onchainTransfersTable.authSignature })
      .returning();
    if (!row) {
      return {
        kind: "rejected" as const,
        error: "This withdrawal authorization was already used. Sign a fresh one to withdraw again.",
      };
    }

    await tx
      .update(treasuryStateTable)
      .set({
        usdcUnits: sql`${treasuryStateTable.usdcUnits} - ${amountUsdc}`,
        updatedAt: new Date(),
      })
      .where(eq(treasuryStateTable.id, treasuryId));

    return { kind: "reserved" as const, row };
  });

  if (reservation.kind === "rejected") {
    await auditSafe({
      treasuryId,
      action: "wallet.withdrawal.request",
      actorWallet: req.operator!.wallet,
      actorRole: req.operator!.role,
      sessionId: req.operator!.sessionId,
      result: "denied",
      reason: reservation.error,
      detail: { destination: address, amountUsdc },
    });
    res.status(409).json({ error: reservation.error });
    return;
  }
  const pending = reservation.row;
  await auditSafe({
    treasuryId,
    action: "wallet.withdrawal.request",
    actorWallet: req.operator!.wallet,
    actorRole: req.operator!.role,
    sessionId: req.operator!.sessionId,
    resourceId: pending.id,
    result: "ok",
    detail: { destination: address, amountUsdc },
  });

  // Status-guarded so a concurrent reconciliation can never double-refund.
  const refundAndFail = async (reason: string): Promise<void> => {
    await db.transaction(async (tx) => {
      await lockTreasuryTransitions(tx, treasuryId);
      const [claimed] = await tx
        .update(onchainTransfersTable)
        .set({ status: "failed" })
        .where(
          and(
            eq(onchainTransfersTable.treasuryId, treasuryId),
            eq(onchainTransfersTable.id, pending.id),
            eq(onchainTransfersTable.status, "pending"),
          ),
        )
        .returning();
      if (!claimed) return;
      await tx
        .update(treasuryStateTable)
        .set({
          usdcUnits: sql`${treasuryStateTable.usdcUnits} + ${amountUsdc}`,
          updatedAt: new Date(),
        })
        .where(eq(treasuryStateTable.id, treasuryId));
    });
    req.log.error({ transferId: pending.id, address, amountUsdc, reason }, "Withdrawal failed; units refunded");
  };

  // Phase 2 - sign + broadcast, serialized by the custody lock: the pending
  // nonce is read from the chain at signing time, so overlapping withdrawals
  // must never interleave between nonce read and broadcast.
  //
  // Refund rules: signing failures happen before anything reaches the
  // mempool (definitively refundable), as do definitive node rejections
  // (SEND_FAILED). A transport failure mid-broadcast (SEND_UNCERTAIN) means
  // the tx may still land - the reservation stands and reconciliation
  // resolves it by the hash persisted BEFORE the broadcast.
  let signed: SignedTransfer | undefined;
  let halted: string | undefined;
  try {
    await withCustodyLock(treasuryId, async (custodyTx) => {
      // The emergency pause is re-read HERE, holding the custody send lock
      // that activating a pause must also take. Phase 1's check bound this
      // withdrawal when it reserved; between then and now the treasury may
      // have been halted, and a reservation is not permission to send. Under
      // this lock the two orderings are the only ones possible: the pause
      // committed first and this transfer is refunded unsent, or this
      // transfer is already out and the pause waits for it.
      halted = (await checkWithdrawalHalt(custodyTx, treasuryId)) ?? undefined;
      if (halted) return;
      signed = await signUsdcTransfer(wallet, address, microUsdc, custodyTx);
      // Persist the hash BEFORE broadcast, guarded on the row still being
      // pending: if reconciliation already refunded this reservation as
      // stale, we must abort instead of broadcasting an unaccounted send.
      const [hashPersisted] = await custodyTx
        .update(onchainTransfersTable)
        .set({
          txHash: signed.hash,
          txNonce: signed.nonce,
          signedPayload: sealRecoveryPayload(signed.serialized),
          broadcastAttempts: 1,
          lastBroadcastAt: new Date(),
          recoveryState: "retrying",
        })
        .where(
          and(
            eq(onchainTransfersTable.treasuryId, treasuryId),
            eq(onchainTransfersTable.id, pending.id),
            eq(onchainTransfersTable.status, "pending"),
          ),
        )
        .returning();
      if (!hashPersisted) {
        throw new ChainError(
          "SEND_FAILED",
          "The withdrawal reservation was already resolved before broadcast; nothing was sent. Please retry.",
        );
      }
      await broadcastSignedTransfer(signed);
    });
  } catch (error) {
    const internalMessage = error instanceof Error ? error.message : String(error);
    const publicMessage =
      error instanceof ChainError ? publicChainError(error) : "The withdrawal could not be processed.";
    // Everything before broadcastSignedTransfer (signing, the hash write)
    // throws without touching the mempool, and broadcast itself only signals
    // a possibly-accepted send via SEND_UNCERTAIN - so refund for any other
    // error, including non-ChainError DB failures after signing.
    const uncertain = error instanceof ChainError && error.code === "SEND_UNCERTAIN";
    if (!uncertain) {
      await refundAndFail(internalMessage);
      req.log.error({ err: error, transferId: pending.id }, "Withdrawal signing or broadcast failed");
      res.status(502).json({ error: `${publicMessage} The reserved units were returned to the treasury.` });
      return;
    }
    req.log.error(
      { err: error, transferId: pending.id, txHash: signed?.hash },
      "Broadcast outcome uncertain; left pending for reconciliation",
    );
    res.status(502).json({
      error: `${publicMessage} The withdrawal stays pending and will be reconciled automatically. Check the explorer: ${EXPLORER_URL}/tx/${signed?.hash}`,
    });
    return;
  }
  if (halted) {
    // Nothing was signed, so the reservation is definitively refundable: the
    // units go back and the row is closed, rather than being left pending and
    // blocking every other withdrawal for as long as the pause lasts.
    await refundAndFail(halted);
    await auditSafe({
      treasuryId,
      action: "wallet.withdrawal.request",
      actorWallet: req.operator!.wallet,
      actorRole: req.operator!.role,
      sessionId: req.operator!.sessionId,
      resourceId: pending.id,
      result: "denied",
      reason: halted,
      detail: { destination: address, amountUsdc, stage: "pre-signing" },
    });
    res.status(409).json({ error: `${halted} The reserved units were returned to the treasury.` });
    return;
  }
  if (!signed) {
    // Unreachable: withCustodyLock resolved, so signing completed.
    res.status(500).json({ error: "Internal error: withdrawal signing state was lost" });
    return;
  }
  const txHash = signed.hash;

  // Phase 3 - confirm. A revert is refundable; an unobservable outcome is
  // NOT (the transfer may still land), so the row stays pending and the
  // reservation stands.
  try {
    await confirmTransfer(txHash);
  } catch (error) {
    if (error instanceof ChainError && error.code === "TX_REVERTED") {
      await refundAndFail(error.message);
      req.log.error({ err: error, transferId: pending.id, txHash }, "Withdrawal reverted");
      res.status(502).json({ error: `${publicChainError(error)} The reserved units were returned to the treasury.` });
      return;
    }
    const publicMessage =
      error instanceof ChainError ? publicChainError(error) : "Withdrawal confirmation could not be observed.";
    req.log.error({ err: error, transferId: pending.id, txHash }, "Withdrawal confirmation unobservable; left pending");
    res.status(502).json({
      error: `${publicMessage} The withdrawal stays pending. Check the explorer: ${EXPLORER_URL}/tx/${txHash}`,
    });
    return;
  }

  const [confirmedRow] = await db
    .update(onchainTransfersTable)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(
      and(
        eq(onchainTransfersTable.treasuryId, treasuryId),
        eq(onchainTransfersTable.id, pending.id),
        eq(onchainTransfersTable.status, "pending"),
      ),
    )
    .returning();
  const confirmed =
    confirmedRow ??
    (
      await db
        .select()
        .from(onchainTransfersTable)
        .where(
          and(
            eq(onchainTransfersTable.treasuryId, treasuryId),
            eq(onchainTransfersTable.id, pending.id),
          ),
        )
    )[0];

  await logActivity(
    treasuryId,
    "On-chain withdrawal executed",
    `${amountUsdc.toLocaleString("en-US", { maximumFractionDigits: 6 })} testnet USDC sent to ${address} on Arc Testnet (tx ${txHash.slice(0, 10)}…). Debited from the liquid reserve.`,
    "executed",
    "onchain",
  );
  req.log.info({ txHash, amountUsdc, address }, "On-chain withdrawal confirmed");
  res.status(201).json(RequestTreasuryWithdrawalResponse.parse(serializeTransfer(confirmed)));
});

export default router;
