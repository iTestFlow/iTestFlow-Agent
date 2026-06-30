import { beforeAll, describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  isEncryptionConfigured,
  maskSecret,
  secretsEqual,
} from "@/modules/security/encryption.service";

// Deterministic test key (32 bytes, base64). The service reads APP_ENCRYPTION_KEY
// at call time, so setting it here is sufficient; no database required.
beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
});

describe("encryption service", () => {
  it("round-trips a secret without leaking plaintext into the ciphertext", () => {
    const enc = encryptSecret("super-secret-pat-1234");
    expect(enc.ciphertext).not.toContain("super-secret");
    expect(enc.keyVersion).toBe(1);
    expect(decryptSecret(enc)).toBe("super-secret-pat-1234");
  });

  it("uses a unique IV per call (same plaintext -> different ciphertext)", () => {
    const a = encryptSecret("same-value");
    const b = encryptSecret("same-value");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("masks to the last four characters", () => {
    expect(maskSecret("abcdef1234")).toBe("••••1234");
    expect(maskSecret("ab")).toBe("••••");
  });

  it("rejects tampered ciphertext (auth tag mismatch)", () => {
    const enc = encryptSecret("x");
    expect(() => decryptSecret({ ...enc, tag: Buffer.alloc(16, 0).toString("base64") })).toThrow();
  });

  it("reports key readiness without throwing", () => {
    expect(isEncryptionConfigured()).toBe(true);
    const key = process.env.APP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    expect(isEncryptionConfigured()).toBe(false);
    process.env.APP_ENCRYPTION_KEY = "invalid";
    expect(isEncryptionConfigured()).toBe(false);
    process.env.APP_ENCRYPTION_KEY = key;
  });

  it("compares equal-length secrets in constant time and rejects different lengths", () => {
    expect(secretsEqual("same", "same")).toBe(true);
    expect(secretsEqual("same", "diff")).toBe(false);
    expect(secretsEqual("short", "longer")).toBe(false);
  });
});
