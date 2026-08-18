import "server-only";

import { createId, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/modules/security/encryption.service";
import {
  MAX_TEST_DATA_ENTRIES,
  TestDataResolutionError,
  type PreparedTestDataEntry,
  type TestDataInput,
  type TestDataMetaEntry,
} from "./execution-test-data.shared";

export {
  MAX_TEST_DATA_ENTRIES,
  MAX_TEST_DATA_TITLE_LENGTH,
  MAX_TEST_DATA_VALUE_LENGTH,
  TestDataResolutionError,
  type PreparedTestDataEntry,
  type TestDataInput,
  type TestDataMetaEntry,
} from "./execution-test-data.shared";

type EncryptedQuadRow = {
  encrypted_value: string;
  value_iv: string;
  value_tag: string;
  value_key_version: number;
};

function quadToSecret(row: EncryptedQuadRow): EncryptedSecret {
  return { ciphertext: row.encrypted_value, iv: row.value_iv, tag: row.value_tag, keyVersion: row.value_key_version };
}

async function savedRunSecret(workspaceId: string, projectId: string, runId: string, title: string): Promise<EncryptedSecret | null> {
  const row = await sqlGet<EncryptedQuadRow>(
    `SELECT d.encrypted_value, d.value_iv, d.value_tag, d.value_key_version
       FROM playwright_execution_run_data d
       JOIN playwright_execution_runs r ON r.id = d.run_id
      WHERE d.run_id = @runId AND r.workspace_id = @workspaceId AND r.project_id = @projectId
        AND d.is_secret AND lower(d.title) = lower(@title)`,
    { runId, workspaceId, projectId, title },
  );
  return row ? quadToSecret(row) : null;
}

async function savedProfileSecret(workspaceId: string, projectId: string, profileId: string, title: string): Promise<EncryptedSecret | null> {
  const row = await sqlGet<EncryptedQuadRow>(
    `SELECT d.encrypted_value, d.value_iv, d.value_tag, d.value_key_version
       FROM playwright_execution_profile_data d
       JOIN playwright_execution_profiles p ON p.id = d.profile_id
      WHERE d.profile_id = @profileId AND p.workspace_id = @workspaceId AND p.project_id = @projectId
        AND d.is_secret AND lower(d.title) = lower(@title)`,
    { profileId, workspaceId, projectId, title },
  );
  return row ? quadToSecret(row) : null;
}

/**
 * Turns client-submitted rows into storable entries: encrypts new secret values
 * and copies the encrypted quad verbatim for saved references (ownership-checked
 * against the workspace + project; no decrypt/re-encrypt round trip).
 *
 * `keepSourceProfileId` lets a profile update omit both value and reference on a
 * secret row to mean "keep this profile's saved value".
 */
export async function resolveTestDataEntries(input: {
  workspaceId: string;
  projectId: string;
  entries: readonly TestDataInput[];
  keepSourceProfileId?: string;
}): Promise<PreparedTestDataEntry[]> {
  if (input.entries.length > MAX_TEST_DATA_ENTRIES) {
    throw new TestDataResolutionError(`Use at most ${MAX_TEST_DATA_ENTRIES} test data entries.`);
  }
  const seenTitles = new Set<string>();
  const prepared: PreparedTestDataEntry[] = [];
  for (const entry of input.entries) {
    const title = entry.title.trim();
    if (!title) throw new TestDataResolutionError("Every test data entry needs a title.");
    const titleKey = title.toLowerCase();
    if (seenTitles.has(titleKey)) throw new TestDataResolutionError(`Test data titles must be unique — "${title}" is used more than once.`);
    seenTitles.add(titleKey);
    if (!entry.isSecret) {
      if (typeof entry.value !== "string" || !entry.value.length) {
        throw new TestDataResolutionError(`Enter a value for "${title}" or remove it.`);
      }
      prepared.push({ title, isSecret: false, value: entry.value });
      continue;
    }
    if (typeof entry.value === "string" && entry.value.length) {
      prepared.push({ title, isSecret: true, encrypted: encryptSecret(entry.value) });
      continue;
    }
    const sourceTitle = entry.sourceTitle?.trim() || title;
    const fromProfileId = entry.fromProfileId ?? (entry.fromRunId ? undefined : input.keepSourceProfileId);
    const saved = entry.fromRunId
      ? await savedRunSecret(input.workspaceId, input.projectId, entry.fromRunId, sourceTitle)
      : fromProfileId
        ? await savedProfileSecret(input.workspaceId, input.projectId, fromProfileId, sourceTitle)
        : null;
    if (!saved) {
      throw new TestDataResolutionError(
        entry.fromRunId || fromProfileId
          ? `The saved value for "${title}" is no longer available. Enter it again.`
          : `Enter a value for "${title}" or remove it.`,
      );
    }
    prepared.push({ title, isSecret: true, encrypted: saved });
  }
  return prepared;
}

type DbClient = Parameters<typeof sqlRun>[2];

export async function insertRunTestData(client: DbClient, runId: string, entries: readonly PreparedTestDataEntry[], now: string): Promise<void> {
  for (const [position, entry] of entries.entries()) {
    await sqlRun(
      `INSERT INTO playwright_execution_run_data (
         id, run_id, position, title, is_secret, value, encrypted_value, value_iv, value_tag, value_key_version, created_at
       ) VALUES (@id, @runId, @position, @title, @isSecret, @value, @encryptedValue, @iv, @tag, @keyVersion, @now)`,
      {
        id: createId("pwdata"), runId, position, title: entry.title, isSecret: entry.isSecret,
        value: entry.isSecret ? null : entry.value,
        encryptedValue: entry.isSecret ? entry.encrypted.ciphertext : null,
        iv: entry.isSecret ? entry.encrypted.iv : null,
        tag: entry.isSecret ? entry.encrypted.tag : null,
        keyVersion: entry.isSecret ? entry.encrypted.keyVersion : null,
        now,
      },
      client,
    );
  }
}

/** Detail-route view: non-secret values in the clear, secret values never. */
export async function runTestDataMeta(runId: string): Promise<TestDataMetaEntry[]> {
  const rows = await sqlAll<{ title: string; is_secret: boolean; value: string | null }>(
    `SELECT title, is_secret, value FROM playwright_execution_run_data WHERE run_id = @runId ORDER BY position, title`, { runId },
  );
  return rows.map((row) => ({ title: row.title, isSecret: row.is_secret, value: row.is_secret ? null : row.value }));
}

/** Worker-only: decrypted title/value pairs handed to the execution agent. */
export async function decryptedRunTestData(runId: string): Promise<Array<{ title: string; value: string; isSecret: boolean }>> {
  const rows = await sqlAll<{ title: string; is_secret: boolean; value: string | null } & Partial<EncryptedQuadRow>>(
    `SELECT title, is_secret, value, encrypted_value, value_iv, value_tag, value_key_version
       FROM playwright_execution_run_data WHERE run_id = @runId ORDER BY position, title`, { runId },
  );
  return rows.map((row) => ({
    title: row.title,
    isSecret: row.is_secret,
    value: row.is_secret
      ? decryptSecret(quadToSecret(row as EncryptedQuadRow))
      : row.value ?? "",
  }));
}
