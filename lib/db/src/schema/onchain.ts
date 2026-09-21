import { doublePrecision, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The treasury's own Arc mainnet custody wallet. Auto-provisioned on first
 * use so depositors have a real on-chain address to send USDC to and
 * withdrawals can be signed server-side. This key holds real USDC and EURC
 * on Arc mainnet: the chain id is verified against Arc (5042) before any
 * on-chain operation, the key is sealed at rest and the signer only accepts
 * an allowlisted set of calls.
 */
export const treasuryWalletTable = pgTable("treasury_wallet", {
  id: text("id").primaryKey(),
  address: text("address").notNull(),
  /** Legacy plaintext key - null once migrated to envelope encryption. */
  privateKey: text("private_key"),
  /** AES-256-GCM ciphertext of the private key (base64: iv|tag|data), sealed with the DEK. */
  encryptedKey: text("encrypted_key"),
  /** The random data-encryption key, itself sealed with the HKDF-derived master key. */
  encryptedDek: text("encrypted_dek"),
  /** Envelope format version (e.g. "v1") so future rotations can coexist. */
  keyVersion: text("key_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TreasuryWallet = typeof treasuryWalletTable.$inferSelect;

/**
 * Append-only ledger of real on-chain USDC movements between user
 * wallets and the treasury. `txHash` is unique so a deposit transaction can
 * never be credited twice; withdrawal rows are inserted `pending` (units
 * already debited as a reservation) and move to `confirmed` or `failed`
 * (units refunded) once the on-chain send resolves.
 */
export const onchainTransfersTable = pgTable("onchain_transfers", {
  id: text("id").primaryKey(),
  treasuryId: text("treasury_id").notNull().default("main"),
  /** "deposit" (user -> treasury) or "withdrawal" (treasury -> user). */
  direction: text("direction").notNull(),
  /** Counterparty user wallet address, lowercased. */
  wallet: text("wallet").notNull(),
  /** Amount in USDC (ERC-20 interface units, 6 decimals of precision). */
  amountUsdc: doublePrecision("amount_usdc").notNull(),
  /** On-chain transaction hash; null only while a withdrawal send is in flight. */
  txHash: text("tx_hash").unique(),
  /** "confirmed" | "pending" | "failed". */
  status: text("status").notNull(),
  /**
   * Withdrawals only: the depositor's EIP-191 authorization signature.
   * Unique so a captured authorization can never be replayed.
   */
  authSignature: text("auth_signature").unique(),
  /** Encrypted exact raw signed transaction, used only for safe identical rebroadcast. */
  signedPayload: text("signed_payload"),
  /** Arc account nonce encoded in signedPayload; operational metadata, never serialized publicly. */
  txNonce: integer("tx_nonce"),
  broadcastAttempts: integer("broadcast_attempts").notNull().default(0),
  lastBroadcastAt: timestamp("last_broadcast_at", { withTimezone: true }),
  /** null | retrying | manual_review; status remains pending while outcome is uncertain. */
  recoveryState: text("recovery_state"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
});

export type OnchainTransfer = typeof onchainTransfersTable.$inferSelect;
