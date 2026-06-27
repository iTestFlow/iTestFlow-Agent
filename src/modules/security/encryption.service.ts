import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";

/**
 * AES-256-GCM secret encryption (ADR / target credential requirements).
 *
 * The key comes from APP_ENCRYPTION_KEY (env / secret manager) — never stored in
 * the database or app data folder. Each secret gets a fresh 12-byte IV; the
 * ciphertext, IV, and auth tag are stored separately. `keyVersion` is recorded
 * with every encrypted value so keys can be rotated later (add APP_ENCRYPTION_KEY_V2
 * and a `case 2` in resolveKey, then re-encrypt lazily) without a schema change.
 */

const CURRENT_KEY_VERSION = 1;
const IV_BYTES = 12;

export type EncryptedSecret = {
  ciphertext: string;
  iv: string;
  tag: string;
  keyVersion: number;
};

export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

function resolveKey(version: number): Buffer {
  const raw = version === CURRENT_KEY_VERSION ? process.env.APP_ENCRYPTION_KEY : undefined;
  if (!raw) {
    throw new EncryptionConfigError(
      `APP_ENCRYPTION_KEY (v${version}) is not configured. Set a base64-encoded 32-byte key — see .env.example.`,
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new EncryptionConfigError(
      "APP_ENCRYPTION_KEY must decode to exactly 32 bytes (base64). Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\".",
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = resolveKey(CURRENT_KEY_VERSION);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

export function decryptSecret(secret: EncryptedSecret): string {
  const key = resolveKey(secret.keyVersion);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(secret.iv, "base64"));
  decipher.setAuthTag(Buffer.from(secret.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(secret.ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Non-reversible preview for UI/status: last 4 chars behind bullets, never the secret. */
export function maskSecret(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/** True when APP_ENCRYPTION_KEY is present and valid — used by health/readiness checks. */
export function isEncryptionConfigured(): boolean {
  try {
    resolveKey(CURRENT_KEY_VERSION);
    return true;
  } catch {
    return false;
  }
}

/** Constant-time compare for secret material (e.g. confirmation flows). */
export function secretsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
