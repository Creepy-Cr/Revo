import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Envelope encryption for the treasury custody key (AES-256-GCM).
 *
 * - A random 32-byte data-encryption key (DEK) seals the private key.
 * - The DEK is itself sealed with a master key derived via HKDF-SHA256 from
 *   CUSTODY_MASTER_SECRET using a dedicated info string.
 * - Both ciphertexts are stored as base64(iv | gcmTag | data).
 *
 * Failures are loud: a missing secret or a tampered ciphertext throws and the
 * custody operation aborts - funds are never moved with an unverified key.
 */

const KEY_VERSION = "v1";
const HKDF_SALT = "aegis-treasury-custody";
const HKDF_INFO = "aegis-custody-master-v1";
const RECOVERY_HKDF_INFO = "aegis-custody-recovery-payload-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Production deliberately has no session-secret fallback: custody and session
 * key material must have independent rotation and blast radii. Development
 * retains the legacy fallback solely for explicit local use.
 */
function masterSecrets(): string[] {
  const configured =
    process.env.NODE_ENV === "production"
      ? [process.env.CUSTODY_MASTER_SECRET]
      : [process.env.CUSTODY_MASTER_SECRET, process.env.SESSION_SECRET];
  const candidates = configured.filter(
    (s): s is string => typeof s === "string" && s.length >= 16,
  );
  if (candidates.length === 0) {
    throw new Error(process.env.NODE_ENV === "production"
      ? "CUSTODY_MASTER_SECRET must be set (>=16 chars) for custody operations in production"
      : "CUSTODY_MASTER_SECRET (or SESSION_SECRET for local development) must be set (>=16 chars)");
  }
  return candidates;
}

/** Fail production startup before accepting custody requests if misconfigured. */
export function assertCustodyConfiguration(): void {
  void masterSecrets();
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32));
}

function deriveRecoveryKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, RECOVERY_HKDF_INFO, 32));
}

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function open(key: Buffer, sealed: string): Buffer {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new Error("Sealed custody payload is malformed");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
}

export interface SealedCustodyKey {
  encryptedKey: string;
  encryptedDek: string;
  keyVersion: string;
}

export function sealCustodyKey(privateKeyHex: string): SealedCustodyKey {
  const dek = randomBytes(32);
  return {
    encryptedKey: seal(dek, Buffer.from(privateKeyHex, "utf8")),
    encryptedDek: seal(deriveKey(masterSecrets()[0]), dek),
    keyVersion: KEY_VERSION,
  };
}

export interface UnsealedCustodyKey {
  privateKey: `0x${string}`;
  /** True when a non-primary (legacy) secret opened the envelope - caller should rewrap. */
  needsRewrap: boolean;
}

export function openCustodyKey(sealed: {
  encryptedKey: string | null;
  encryptedDek: string | null;
  keyVersion: string | null;
}): UnsealedCustodyKey {
  if (!sealed.encryptedKey || !sealed.encryptedDek) {
    throw new Error("Custody wallet has no sealed key material");
  }
  if (sealed.keyVersion !== KEY_VERSION) {
    throw new Error(`Unsupported custody key version: ${sealed.keyVersion ?? "none"}`);
  }
  const secrets = masterSecrets();
  for (let i = 0; i < secrets.length; i++) {
    try {
      const dek = open(deriveKey(secrets[i]), sealed.encryptedDek);
      const privateKey = open(dek, sealed.encryptedKey).toString("utf8");
      if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error("Unsealed custody key failed shape validation");
      }
      return { privateKey: privateKey as `0x${string}`, needsRewrap: i > 0 };
    } catch {}
  }
  throw new Error("No configured master secret can open the custody envelope");
}

/** Encrypt a raw signed transaction before durable recovery storage. */
export function sealRecoveryPayload(payload: `0x${string}`): string {
  return seal(deriveRecoveryKey(masterSecrets()[0]), Buffer.from(payload, "utf8"));
}

/** Decrypt a recovery payload. Legacy development-secret fallback is read-only. */
export function openRecoveryPayload(payload: string): `0x${string}` {
  for (const secret of masterSecrets()) {
    try {
      const opened = open(deriveRecoveryKey(secret), payload).toString("utf8");
      if (/^0x[0-9a-fA-F]+$/.test(opened)) return opened as `0x${string}`;
    } catch {}
  }
  throw new Error("No configured master secret can open the withdrawal recovery payload");
}
