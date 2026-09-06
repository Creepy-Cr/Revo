import {
  BaseError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { db, pool, treasuryWalletTable, type TreasuryWallet } from "@workspace/db";
import * as dbSchema from "@workspace/db/schema";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { openCustodyKey, sealCustodyKey } from "./custody-crypto";
import { logger } from "./logger";

export type CustodyTransaction = NodePgDatabase<typeof dbSchema>;
type CustodyExecutor = typeof db | CustodyTransaction;

/**
 * Real Arc Testnet (Circle) chain access.
 *
 * Guardrails, enforced here and nowhere overridable:
 * - The RPC client is pinned to Arc TESTNET and every on-chain operation
 *   first verifies the node actually reports chain id 5042002. If the RPC
 *   answers with any other chain (i.e. someone points ARC_TESTNET_RPC_URL at
 *   a mainnet node), we refuse loudly.
 * - RPC failures are explicit errors - no cached, synthetic, or assumed
 *   on-chain state is ever fabricated.
 */

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_TESTNET_CHAIN_ID_HEX = "0x4cef52";
export const ARC_TESTNET_CHAIN_NAME = "Arc Testnet";
export const ARC_RPC_URL = process.env.ARC_TESTNET_RPC_URL ?? "https://rpc.testnet.arc.io";
/** USDC is Arc's native asset; this is its ERC-20 interface (6 decimals). */
export const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";
export const USDC_DECIMALS = 6;
export const EXPLORER_URL = "https://testnet.arcscan.app";
export const FAUCET_URL = "https://faucet.circle.com";

/** Micro-USDC (6-decimal integer) conversions. */
export const toMicroUsdc = (amount: number): bigint => BigInt(Math.round(amount * 1e6));
export const fromMicroUsdc = (micro: bigint): number => Number(micro) / 1e6;

const erc20Abi = parseAbi([
  "function transfer(address to, uint256 value) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const arcTestnet = defineChain({
  id: ARC_TESTNET_CHAIN_ID,
  name: ARC_TESTNET_CHAIN_NAME,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: "Arcscan", url: EXPLORER_URL } },
  testnet: true,
});

/** Typed on-chain failure so routes can map causes to honest status codes. */
export class ChainError extends Error {
  constructor(
    public readonly code:
      | "RPC_UNAVAILABLE"
      | "WRONG_CHAIN"
      | "TX_NOT_FOUND"
      | "TX_REVERTED"
      | "NOT_A_DEPOSIT"
      | "SEND_FAILED"
      | "SEND_UNCERTAIN"
      | "SIMULATION_REVERTED",
    message: string,
  ) {
    super(message);
    this.name = "ChainError";
  }
}

function safeUpstreamDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/0x[0-9a-fA-F]{128,}/g, "[redacted signed payload]")
    .slice(0, 1_000);
}

/**
 * The exact message a depositor signs (EIP-191 personal_sign) to authorize a
 * withdrawal to their own wallet. MUST stay byte-identical to the frontend
 * builder in artifacts/arc-treasury-dao/src/lib/arc-wallet.ts.
 */
export function withdrawalAuthMessage(address: string, amount: string, issuedAt: string): string {
  return [
    "Revo Treasury testnet withdrawal",
    `Amount: ${amount} USDC`,
    `Destination: ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    `Chain: Arc Testnet (${ARC_TESTNET_CHAIN_ID})`,
  ].join("\n");
}

const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL, { timeout: 15_000 }),
});

/**
 * Confirms the RPC node really is Arc Testnet (chain id 5042002) before any
 * on-chain read or write. Deliberately NOT cached: it is re-verified per
 * operation so an endpoint that rebinds mid-process is still refused - this
 * service never touches a non-testnet chain.
 */
export async function assertArcTestnet(): Promise<void> {
  let reportedId: number;
  try {
    reportedId = await publicClient.getChainId();
  } catch (error) {
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `Arc Testnet RPC is unreachable (${safeUpstreamDetail(error)}). No on-chain action was taken.`,
    );
  }
  if (reportedId !== ARC_TESTNET_CHAIN_ID) {
    throw new ChainError(
      "WRONG_CHAIN",
      `Refusing to operate: RPC reports chain id ${reportedId}, expected Arc Testnet (${ARC_TESTNET_CHAIN_ID}). Execution is locked to testnet.`,
    );
  }
}

/**
 * Loads (or provisions on first use) a treasury's own Arc Testnet custody
 * wallet - one row per treasury, keyed by the treasury id. The key is
 * generated server-side and only ever used against the chain-id-verified
 * testnet RPC, so it can never hold mainnet value.
 */
export async function ensureTreasuryWallet(
  treasuryId: string,
  signal?: AbortSignal,
): Promise<TreasuryWallet> {
  const [existing] = await db
    .select()
    .from(treasuryWalletTable)
    .where(eq(treasuryWalletTable.id, treasuryId));
  if (existing) return migratePlaintextKey(existing, signal);

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const sealed = sealCustodyKey(privateKey);
  signal?.throwIfAborted();
  const [created] = await db
    .insert(treasuryWalletTable)
    .values({
      id: treasuryId,
      address: account.address,
      privateKey: null,
      encryptedKey: sealed.encryptedKey,
      encryptedDek: sealed.encryptedDek,
      keyVersion: sealed.keyVersion,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // Another request provisioned concurrently - load the winner.
  const [winner] = await db
    .select()
    .from(treasuryWalletTable)
    .where(eq(treasuryWalletTable.id, treasuryId));
  return winner;
}

/**
 * One-time migration: seals a legacy plaintext custody key and erases the
 * plaintext column. Runs lazily on first wallet load after deploy.
 */
async function migratePlaintextKey(
  wallet: TreasuryWallet,
  signal?: AbortSignal,
  executor: CustodyExecutor = db,
): Promise<TreasuryWallet> {
  if (!wallet.privateKey || wallet.encryptedKey) return wallet;
  const sealed = sealCustodyKey(wallet.privateKey);
  signal?.throwIfAborted();
  const [updated] = await executor
    .update(treasuryWalletTable)
    .set({
      privateKey: null,
      encryptedKey: sealed.encryptedKey,
      encryptedDek: sealed.encryptedDek,
      keyVersion: sealed.keyVersion,
    })
    .where(
      and(eq(treasuryWalletTable.id, wallet.id), isNotNull(treasuryWalletTable.privateKey)),
    )
    .returning();
  logger.info({ wallet: wallet.address }, "Custody key sealed with envelope encryption");
  return updated ?? wallet;
}

/** Resolves the signing key: sealed envelope preferred, legacy plaintext only as a bridge. */
async function custodySigningKey(
  wallet: TreasuryWallet,
  executor: CustodyExecutor,
): Promise<Hex> {
  if (wallet.encryptedKey) {
    const unsealed = openCustodyKey(wallet);
    if (unsealed.needsRewrap) {
      // A legacy secret opened the envelope - rewrap with the primary in the
      // background so custody survives retiring the old secret. Best effort:
      // signing must not fail because of housekeeping.
      const resealed = sealCustodyKey(unsealed.privateKey);
      try {
        await executor
          .update(treasuryWalletTable)
          .set({
            encryptedKey: resealed.encryptedKey,
            encryptedDek: resealed.encryptedDek,
            keyVersion: resealed.keyVersion,
          })
          .where(eq(treasuryWalletTable.id, wallet.id));
        logger.info("Custody envelope rewrapped with primary master secret");
      } catch (err) {
        logger.error({ err }, "Custody envelope rewrap failed");
      }
    }
    return unsealed.privateKey;
  }
  if (wallet.privateKey) return wallet.privateKey as Hex;
  throw new ChainError("SEND_FAILED", "Custody wallet has no usable key material");
}

export interface VerifiedDeposit {
  /** Depositor address, lowercased. */
  from: string;
  /** Deposited amount in micro-USDC (6-decimal integer). */
  microUsdc: bigint;
}

/**
 * Verifies a claimed deposit transaction against the Arc Testnet RPC. Only a
 * successful, mined transaction that actually moved USDC to the treasury
 * address counts - either via ERC-20 `Transfer` logs (6 decimals) or as a
 * native-value send (18 decimals; same underlying USDC balance on Arc).
 */
export async function verifyDeposit(
  txHash: Hex,
  treasuryAddress: string,
): Promise<VerifiedDeposit> {
  await assertArcTestnet();

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  } catch (error) {
    const message = safeUpstreamDetail(error);
    if (/not.*found|could not be found/i.test(message)) {
      throw new ChainError(
        "TX_NOT_FOUND",
        "That transaction is not on Arc Testnet (yet). Wait for it to confirm, then try again.",
      );
    }
    throw new ChainError("RPC_UNAVAILABLE", `Arc Testnet RPC failed while verifying: ${message}`);
  }

  if (receipt.status !== "success") {
    throw new ChainError("TX_REVERTED", "That transaction reverted on-chain; nothing was deposited.");
  }

  const treasury = treasuryAddress.toLowerCase();

  // ERC-20 Transfer(s) into the treasury on the USDC interface contract.
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs })
    .filter(
      (log) =>
        log.address.toLowerCase() === USDC_ADDRESS.toLowerCase() &&
        log.args.to.toLowerCase() === treasury &&
        log.args.value > 0n,
    );
  if (transfers.length > 0) {
    // Credit must be attributable to exactly one sender - a transaction that
    // moves USDC to the treasury from multiple wallets would otherwise credit
    // other senders' funds to the first one.
    const senders = new Set(transfers.map((log) => log.args.from.toLowerCase()));
    if (senders.size > 1) {
      throw new ChainError(
        "NOT_A_DEPOSIT",
        "That transaction sent USDC to the treasury from multiple wallets, so it cannot be attributed to a single depositor.",
      );
    }
    const microUsdc = transfers.reduce((sum, log) => sum + log.args.value, 0n);
    return { from: transfers[0].args.from.toLowerCase(), microUsdc };
  }

  // Fall back to a plain native-value send to the treasury (18 decimals).
  let tx;
  try {
    tx = await publicClient.getTransaction({ hash: txHash });
  } catch (error) {
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `Arc Testnet RPC failed while verifying: ${safeUpstreamDetail(error)}`,
    );
  }
  if (tx.to && tx.to.toLowerCase() === treasury && tx.value > 0n) {
    // Native USDC uses 18 decimals; round down to whole micro-USDC.
    const microUsdc = tx.value / 10n ** 12n;
    if (microUsdc > 0n) {
      return { from: tx.from.toLowerCase(), microUsdc };
    }
  }

  throw new ChainError(
    "NOT_A_DEPOSIT",
    "That transaction did not transfer testnet USDC to the treasury address, so there is nothing to credit.",
  );
}

export interface SignedTransfer {
  /** Deterministic transaction hash, known BEFORE broadcast. */
  hash: Hex;
  serialized: Hex;
  nonce: number;
}

/**
 * Serializes every custody-wallet sign→broadcast sequence PER TREASURY. The
 * pending nonce is read from the chain at signing time, so two overlapping
 * withdrawals from the same custody wallet would otherwise sign different
 * transfers with the SAME nonce - one would mine and the other would become
 * a permanently-pending phantom. Each treasury has its own custody wallet,
 * so queues are keyed by treasury id and tenants never block each other.
 * A session advisory lock on one dedicated pool client provides serialization
 * across every API instance. All database work inside the callback uses the
 * Drizzle executor bound to that same client. Its statements auto-commit, so
 * signed recovery data is durable before broadcast without acquiring a nested
 * pool connection. The local queue avoids occupying multiple clients while
 * requests in this process wait for the same treasury.
 */
const CUSTODY_LOCK_NAMESPACE = "custody-withdrawal";
const custodyQueues = new Map<string, Promise<unknown>>();
export function withCustodyLock<T>(
  treasuryId: string,
  fn: (tx: CustodyTransaction) => Promise<T>,
): Promise<T> {
  const queue = custodyQueues.get(treasuryId) ?? Promise.resolve();
  const runWithDatabaseLock = async () => {
    const client = await pool.connect();
    const executor = drizzle(client, { schema: dbSchema });
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1), hashtext($2))", [
        CUSTODY_LOCK_NAMESPACE,
        treasuryId,
      ]);
      return await fn(executor);
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1), hashtext($2))", [
          CUSTODY_LOCK_NAMESPACE,
          treasuryId,
        ])
        .catch(() => undefined);
      client.release();
    }
  };
  const run = queue.then(runWithDatabaseLock, runWithDatabaseLock);
  custodyQueues.set(
    treasuryId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * The same per-treasury custody lock withCustodyLock holds, scoped to the
 * caller's transaction instead of a session.
 *
 * A transaction that must not be overtaken by a custody send takes this
 * first. The emergency pause does: activating it therefore waits for a
 * transfer that is already being signed or broadcast, and every send that
 * starts after it commits reads the pause under this lock and stops. Without
 * it the pause would only be checked when a withdrawal is reserved, and the
 * seconds between reserving and signing would be a hole in the kill switch.
 */
export function custodySendLock(treasuryId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext(${CUSTODY_LOCK_NAMESPACE}), hashtext(${treasuryId}))`;
}

/**
 * Prepares and locally signs a testnet USDC transfer from the treasury
 * wallet. Nothing touches the mempool here, so ANY failure in this step is
 * definitively refundable. The returned hash is derived from the signed
 * payload, letting the caller persist it before broadcasting - an ambiguous
 * broadcast can then always be reconciled against the chain later.
 */
export async function signUsdcTransfer(
  wallet: TreasuryWallet,
  to: string,
  microUsdc: bigint,
  executor: CustodyExecutor = db,
): Promise<SignedTransfer> {
  await assertArcTestnet();
  if (!isAddress(to)) {
    throw new ChainError("SEND_FAILED", `Invalid destination address: ${to}`);
  }

  const account = privateKeyToAccount(await custodySigningKey(wallet, executor));
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, microUsdc],
  });

  try {
    const [nonce, gas, fees] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      publicClient.estimateGas({ account: account.address, to: USDC_ADDRESS, data }),
      publicClient.estimateFeesPerGas(),
    ]);
    const serialized = await account.signTransaction({
      chainId: ARC_TESTNET_CHAIN_ID,
      type: "eip1559",
      to: USDC_ADDRESS,
      data,
      value: 0n,
      nonce,
      gas: (gas * 12n) / 10n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return { hash: keccak256(serialized), serialized, nonce };
  } catch (error) {
    throw new ChainError(
      "SEND_FAILED",
      `The withdrawal could not be prepared (nothing was broadcast): ${safeUpstreamDetail(error)}`,
    );
  }
}

/** Current ERC-20 allowance the custody wallet has granted a spender. */
export async function readAllowance(
  token: Address,
  owner: string,
  spender: Address,
): Promise<bigint> {
  await assertArcTestnet();
  try {
    return (await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [owner as Address, spender],
    })) as bigint;
  } catch (error) {
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `Arc Testnet RPC failed while reading the token allowance: ${safeUpstreamDetail(error)}`,
    );
  }
}

/** Calldata for an exact-amount ERC-20 approval. */
export function encodeApproval(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
}

/**
 * Runs a contract call through `eth_call` as if the custody wallet had sent
 * it, WITHOUT signing anything. A revert here is the cheapest honest way to
 * find out that a transaction would fail, and it happens before any key is
 * touched, so a refusal at this point definitively moved nothing.
 */
export async function simulateCustodyCall(
  from: string,
  to: Address,
  data: Hex,
): Promise<void> {
  await assertArcTestnet();
  try {
    await publicClient.call({ account: from as Address, to, data });
  } catch (error) {
    const message = safeUpstreamDetail(error);
    // A transport failure is not a revert: refusing on one would report a
    // healthy transaction as broken. Only a real execution failure blocks.
    if (
      error instanceof BaseError &&
      error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null
    ) {
      throw new ChainError(
        "RPC_UNAVAILABLE",
        `Arc Testnet RPC could not simulate the transaction, so it was not signed: ${message}`,
      );
    }
    throw new ChainError(
      "SIMULATION_REVERTED",
      `Simulation reverted, so nothing was signed or sent: ${message}`,
    );
  }
}

/**
 * Prepares and locally signs an arbitrary custody-wallet contract call. Same
 * contract as `signUsdcTransfer`: nothing reaches the mempool here, so any
 * failure in this step definitively moved nothing, and the returned hash is
 * derived from the signed payload so the caller can persist it before
 * broadcasting.
 */
export async function signCustodyCall(
  wallet: TreasuryWallet,
  to: Address,
  data: Hex,
  executor: CustodyExecutor = db,
): Promise<SignedTransfer> {
  await assertArcTestnet();
  const account = privateKeyToAccount(await custodySigningKey(wallet, executor));
  try {
    const [nonce, gas, fees] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      publicClient.estimateGas({ account: account.address, to, data }),
      publicClient.estimateFeesPerGas(),
    ]);
    const serialized = await account.signTransaction({
      chainId: ARC_TESTNET_CHAIN_ID,
      type: "eip1559",
      to,
      data,
      value: 0n,
      nonce,
      gas: (gas * 12n) / 10n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    return { hash: keccak256(serialized), serialized, nonce };
  } catch (error) {
    throw new ChainError(
      "SEND_FAILED",
      `The transaction could not be prepared (nothing was broadcast): ${safeUpstreamDetail(error)}`,
    );
  }
}

/**
 * Micro-USDC that must stay behind to pay for `gasUnits` of execution.
 *
 * Gas on Arc is settled in USDC out of the very balance a transfer moves, so
 * a swap sized at the full USDC balance always reverts at estimation. Callers
 * size spendable balances against this rather than against what is held.
 */
export async function gasReserveMicroUsdc(gasUnits: bigint): Promise<bigint> {
  await assertArcTestnet();
  let fees;
  try {
    fees = await publicClient.estimateFeesPerGas();
  } catch (error) {
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `Arc Testnet gas price could not be read, so no spendable balance could be derived: ${safeUpstreamDetail(error)}`,
    );
  }
  // Native USDC carries 18 decimals; the ERC-20 interface over it carries 6.
  const wei = gasUnits * fees.maxFeePerGas;
  const micro = wei / 10n ** 12n;
  // Round up: reserving a fraction too little is the failure mode that costs
  // a reverted swap, and one extra micro-USDC costs nothing.
  return wei % 10n ** 12n === 0n ? micro : micro + 1n;
}

/** Transport-level failures where the node MAY still have received the tx. */
function isAmbiguousBroadcastFailure(error: unknown): boolean {
  if (!(error instanceof BaseError)) return true; // unknown shape - assume the worst
  return (
    error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null
  );
}

/** Whether the node knows this exact transaction (mempool or mined). */
async function isTxKnown(hash: Hex): Promise<boolean> {
  try {
    await publicClient.getTransaction({ hash });
    return true;
  } catch {
    return false;
  }
}

/**
 * Broadcasts a pre-signed transfer.
 * - SEND_FAILED: the node responded and definitively rejected it - refundable.
 * - SEND_UNCERTAIN: transport failed mid-request; the tx may still land, so
 *   the caller MUST keep the reservation and reconcile by hash later.
 *
 * "already known" / "nonce too low" responses are only trusted as a
 * successful broadcast when THIS exact hash is visible on the node - a
 * generic nonce error can refer to a *different* transaction that consumed
 * the nonce, in which case this transfer can never mine and is refundable.
 */
export async function broadcastSignedTransfer(signed: SignedTransfer): Promise<void> {
  try {
    await publicClient.sendRawTransaction({ serializedTransaction: signed.serialized });
  } catch (error) {
    const message = safeUpstreamDetail(error);

    if (/already known|already imported|nonce too low|replacement transaction/i.test(message)) {
      if (await isTxKnown(signed.hash)) return;
      if (/nonce too low|replacement transaction/i.test(message)) {
        // Another transaction holds this nonce and ours is nowhere on the
        // node we (exclusively) broadcast to - it can never mine.
        throw new ChainError(
          "SEND_FAILED",
          "The withdrawal's nonce was consumed by another treasury transaction before broadcast; this transfer was definitively not accepted.",
        );
      }
      // Node hinted it knows the payload but the hash lookup failed -
      // treat as unknown outcome and let reconciliation resolve it.
      throw new ChainError(
        "SEND_UNCERTAIN",
        `The Arc Testnet RPC reported the transaction as known but it could not be verified (tx ${signed.hash}); it may or may not have been accepted.`,
      );
    }

    if (isAmbiguousBroadcastFailure(error)) {
      throw new ChainError(
        "SEND_UNCERTAIN",
        `The Arc Testnet RPC failed mid-broadcast (tx ${signed.hash}); the transaction may or may not have been accepted.`,
      );
    }
    throw new ChainError("SEND_FAILED", `Arc Testnet rejected the withdrawal transaction: ${message}`);
  }
}

/** Non-throwing receipt probe used to reconcile pending withdrawals. */
export async function getTransferReceiptStatus(
  hash: Hex,
): Promise<"success" | "reverted" | "unknown"> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? "success" : "reverted";
  } catch {
    return "unknown";
  }
}

export async function getTransferRecoveryStatus(
  hash: Hex,
): Promise<"success" | "reverted" | "pending" | "missing" | "unknown"> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? "success" : "reverted";
  } catch {
    // A missing receipt is normal for both mempool and evicted transactions.
  }
  try {
    await publicClient.getTransaction({ hash });
    return "pending";
  } catch (error) {
    const message = safeUpstreamDetail(error);
    return /not.*found|could not be found|unknown transaction/i.test(message)
      ? "missing"
      : "unknown";
  }
}

/** A mined transaction's receipt, as this client formats it. */
export type ConfirmedReceipt = Awaited<
  ReturnType<typeof publicClient.getTransactionReceipt>
>;

/**
 * Waits for an already-broadcast transaction to confirm. TX_REVERTED means
 * the transfer definitively failed on-chain (refundable); RPC_UNAVAILABLE
 * means the outcome is UNKNOWN - the caller must leave the transfer pending
 * and must not refund.
 *
 * The confirmed receipt is returned rather than discarded: it is the only
 * record of what the transaction actually moved. A withdrawal knows its own
 * amount and ignores it; a swap does not, and reads its fill out of the
 * transfer logs.
 */
export async function confirmTransfer(hash: Hex): Promise<ConfirmedReceipt> {
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  } catch (error) {
    throw new ChainError(
      "RPC_UNAVAILABLE",
      `The withdrawal was broadcast (tx ${hash}) but confirmation could not be observed: ${safeUpstreamDetail(error)}`,
    );
  }
  if (receipt.status !== "success") {
    throw new ChainError("TX_REVERTED", `The withdrawal transaction reverted on-chain (tx ${hash}).`);
  }
  return receipt;
}

/**
 * Fetches the receipt of a transaction that is already known to have
 * confirmed, without ever throwing.
 *
 * Null means "the receipt could not be read", never "the transaction did
 * nothing". Callers use this to report on a transaction after the fact, so a
 * failure here has to degrade to "not known" rather than propagate.
 */
export async function getConfirmedReceipt(hash: Hex): Promise<ConfirmedReceipt | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    return receipt.status === "success" ? receipt : null;
  } catch {
    return null;
  }
}

/**
 * Total ERC-20 value `recipient` was credited in `token` by this receipt.
 *
 * This is the exact amount a contract paid out, taken from the transaction's
 * own transfer logs, as opposed to a balance difference measured either side
 * of it: no gas billed against the same balance and no concurrent transfer
 * can move it.
 *
 * Deliberately total and non-throwing. Every caller is reading a transaction
 * that has ALREADY confirmed, so a receipt that cannot be parsed has to come
 * back as "no evidence" - null - rather than as an error that could unsettle
 * something which really happened. Null is never zero.
 */
export function creditedByReceipt(
  receipt: Pick<ConfirmedReceipt, "logs"> | null | undefined,
  token: Address,
  recipient: string,
): bigint | null {
  const logs = receipt?.logs;
  if (!logs || logs.length === 0) return null;
  try {
    const to = recipient.toLowerCase();
    const contract = token.toLowerCase();
    const credited = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs })
      .filter(
        (log) => log.address.toLowerCase() === contract && log.args.to.toLowerCase() === to,
      )
      .reduce((sum, log) => sum + log.args.value, 0n);
    return credited > 0n ? credited : null;
  } catch {
    return null;
  }
}

/**
 * What a confirmed transaction actually paid Arc in gas, in micro-USDC.
 *
 * Arc settles gas in USDC out of the sending wallet's own balance, so this is
 * treasury money spent rather than a fee paid in some separate gas token. The
 * receipt carries both halves of it, so the exact figure costs no extra read.
 *
 * Null means "not known", and specifically never zero. A mined transaction
 * burns a non-zero amount of gas at a non-zero price on Arc, so a missing or
 * zero field is a node that did not report the cost rather than a transaction
 * that was free, and reporting it as free would understate what was spent.
 *
 * Non-throwing for the same reason `creditedByReceipt` is: every caller is
 * describing a transaction that has already confirmed.
 */
export function gasCostMicroUsdc(
  receipt: Pick<ConfirmedReceipt, "gasUsed" | "effectiveGasPrice"> | null | undefined,
): bigint | null {
  const gasUsed = receipt?.gasUsed;
  const price = receipt?.effectiveGasPrice;
  if (typeof gasUsed !== "bigint" || typeof price !== "bigint") return null;
  if (gasUsed <= 0n || price <= 0n) return null;
  // Native USDC carries 18 decimals; the ERC-20 interface over it carries 6.
  const wei = gasUsed * price;
  const micro = wei / 10n ** 12n;
  // Round up, so a cost is never reported as less than what was spent.
  return wei % 10n ** 12n === 0n ? micro : micro + 1n;
}
