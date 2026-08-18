import type { EncryptedSecret } from "@/modules/security/encryption.service";

export const MAX_TEST_DATA_ENTRIES = 20;
export const MAX_TEST_DATA_TITLE_LENGTH = 100;
export const MAX_TEST_DATA_VALUE_LENGTH = 2000;

/**
 * One test-data row as submitted by the client. Secret rows either carry a new
 * plaintext `value` (encrypted before it is stored) or reference the encrypted
 * value already saved on a previous run / profile — the browser never sees or
 * resends saved secret material.
 */
export type TestDataInput = {
  title: string;
  isSecret: boolean;
  value?: string;
  fromRunId?: string;
  fromProfileId?: string;
  /** Title the value was saved under at the source, when the row was renamed. */
  sourceTitle?: string;
};

export type PreparedTestDataEntry =
  | { title: string; isSecret: false; value: string }
  | { title: string; isSecret: true; encrypted: EncryptedSecret };

export type TestDataMetaEntry = { title: string; isSecret: boolean; value: string | null };

/** User-actionable resolution failure — routes surface the message with a 422. */
export class TestDataResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDataResolutionError";
  }
}
