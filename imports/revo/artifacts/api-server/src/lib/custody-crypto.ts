import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Envelope encryption for the treasury custody key (AES-256-GCM).
 *
 * - A random 32-byte data-encryption key (DEK) seals the private key.
 * - The DEK is itself sealed with a master key derived via HKDF-SHA256 from
 *   SESSION_SECRET using a dedicated info string, so the custody master key
 *   is cryptographically separated from any session usage of that secret.
 * - Both ciphertexts are stored as base64(iv | gcmTag | data).
 *
 * Failures are loud: a missing secret or a tampered ciphertext throws and the
 * custody operation aborts - funds are never moved with an unverified key.
 */

const KEY_VERSION = "v1";
const HKDF_SALT = "aegis-treasury-custody";
const HKDF_INFO = "aegis-custody-master-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Master-secret candidates in precedence order. CUSTODY_MASTER_SECRET (when
 * set) decouples custody from session-secret rotation: set it to a new value
 * while the old SESSION_SECRET still opens existing envelopes, and the next
 * custody operation transparently rewraps with the primary. New seals always
 * use the first candidate.
 */
function masterSecrets(): string[] {
  const candidates = [process.env.CUSTODY_MASTER_SECRET, process.env.SESSION_SECRET].filter(
    (s): s is string => typeof s === "string" && s.length >= 16,
  );
  if (candidates.length === 0) {
    throw new Error(
      "CUSTODY_MASTER_SECRET or SESSION_SECRET must be set (>=16 chars) to seal or open the custody key",
    );
  }
  return candidates;
}

function deriveKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32));
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
  let lastError: unknown = null;
  for (let i = 0; i < secrets.length; i++) {
    try {
      const dek = open(deriveKey(secrets[i]), sealed.encryptedDek);
      const privateKey = open(dek, sealed.encryptedKey).toString("utf8");
      if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
        throw new Error("Unsealed custody key failed shape validation");
      }
      return { privateKey: privateKey as `0x${string}`, needsRewrap: i > 0 };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `No configured master secret can open the custody envelope: ${
      lastError instanceof Error ? lastError.message : "unknown"
    }`,
  );
}
