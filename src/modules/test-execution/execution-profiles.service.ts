import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import type { ScreenshotPolicy } from "./screenshot-policy";
import {
  ProfileNameConflictError,
  ProfileNotFoundError,
  type ExecutionProfile,
} from "./execution-profiles.shared";
import {
  resolveTestDataEntries,
  type PreparedTestDataEntry,
  type TestDataInput,
} from "./execution-test-data.service";

export {
  MAX_PROFILE_NAME_LENGTH,
  ProfileNameConflictError,
  ProfileNotFoundError,
  type ExecutionProfile,
} from "./execution-profiles.shared";

type ProfileRow = {
  id: string; name: string; base_url: string | null; execution_notes: string | null;
  screenshot_policy: ScreenshotPolicy; headless: boolean; viewport_width: number; viewport_height: number; updated_at: string;
};

type ProfileDataRow = { profile_id: string; title: string; is_secret: boolean; value: string | null };

type DbClient = Parameters<typeof sqlRun>[2];

async function insertProfileData(client: DbClient, profileId: string, entries: readonly PreparedTestDataEntry[], now: string): Promise<void> {
  for (const [position, entry] of entries.entries()) {
    await sqlRun(
      `INSERT INTO playwright_execution_profile_data (
         id, profile_id, position, title, is_secret, value, encrypted_value, value_iv, value_tag, value_key_version, created_at, updated_at
       ) VALUES (@id, @profileId, @position, @title, @isSecret, @value, @encryptedValue, @iv, @tag, @keyVersion, @now, @now)`,
      {
        id: createId("pwpdata"), profileId, position, title: entry.title, isSecret: entry.isSecret,
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

function mapProfile(row: ProfileRow, data: readonly ProfileDataRow[]): ExecutionProfile {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    executionNotes: row.execution_notes,
    screenshotPolicy: row.screenshot_policy,
    headless: row.headless,
    viewportWidth: row.viewport_width,
    viewportHeight: row.viewport_height,
    testData: data
      .filter((entry) => entry.profile_id === row.id)
      .map((entry) => ({ title: entry.title, isSecret: entry.is_secret, value: entry.is_secret ? null : entry.value })),
    updatedAt: row.updated_at,
  };
}

export async function listExecutionProfiles(workspaceId: string, projectId: string): Promise<ExecutionProfile[]> {
  const rows = await sqlAll<ProfileRow>(
    `SELECT id, name, base_url, execution_notes, screenshot_policy, headless, viewport_width, viewport_height, updated_at
       FROM playwright_execution_profiles
      WHERE workspace_id = @workspaceId AND project_id = @projectId
      ORDER BY lower(name)`,
    { workspaceId, projectId },
  );
  if (!rows.length) return [];
  const data = await sqlAll<ProfileDataRow>(
    `SELECT d.profile_id, d.title, d.is_secret, d.value
       FROM playwright_execution_profile_data d
       JOIN playwright_execution_profiles p ON p.id = d.profile_id
      WHERE p.workspace_id = @workspaceId AND p.project_id = @projectId
      ORDER BY d.position, d.title`,
    { workspaceId, projectId },
  );
  return rows.map((row) => mapProfile(row, data));
}

export async function getExecutionProfile(profileId: string, workspaceId: string, projectId: string): Promise<ExecutionProfile | null> {
  const row = await sqlGet<ProfileRow>(
    `SELECT id, name, base_url, execution_notes, screenshot_policy, headless, viewport_width, viewport_height, updated_at
       FROM playwright_execution_profiles
      WHERE id = @profileId AND workspace_id = @workspaceId AND project_id = @projectId`,
    { profileId, workspaceId, projectId },
  );
  if (!row) return null;
  const data = await sqlAll<ProfileDataRow>(
    `SELECT profile_id, title, is_secret, value FROM playwright_execution_profile_data
      WHERE profile_id = @profileId ORDER BY position, title`,
    { profileId },
  );
  return mapProfile(row, data);
}

export type ProfileWriteInput = {
  workspaceId: string;
  projectId: string;
  userId: string;
  name: string;
  baseUrl: string | null;
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  testData: readonly TestDataInput[];
};

export async function createExecutionProfile(input: ProfileWriteInput): Promise<ExecutionProfile> {
  const name = input.name.trim();
  const entries = await resolveTestDataEntries({ workspaceId: input.workspaceId, projectId: input.projectId, entries: input.testData });
  const profileId = createId("pwprof");
  const now = nowIso();
  const created = await withTransaction(async (client) => {
    const inserted = await sqlGet<{ id: string }>(
      `INSERT INTO playwright_execution_profiles (
         id, workspace_id, project_id, name, base_url, execution_notes, screenshot_policy,
         headless, viewport_width, viewport_height,
         created_by_user_id, updated_by_user_id, created_at, updated_at
       ) VALUES (@id, @workspaceId, @projectId, @name, @baseUrl, @notes, @policy,
         @headless, @viewportWidth, @viewportHeight, @userId, @userId, @now, @now)
       ON CONFLICT (workspace_id, project_id, lower(name)) DO NOTHING RETURNING id`,
      {
        id: profileId, workspaceId: input.workspaceId, projectId: input.projectId, name,
        baseUrl: input.baseUrl, notes: input.executionNotes, policy: input.screenshotPolicy,
        headless: input.headless, viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight,
        userId: input.userId, now,
      },
      client,
    );
    if (!inserted) return false;
    await insertProfileData(client, profileId, entries, now);
    return true;
  });
  if (!created) throw new ProfileNameConflictError(name);
  const profile = await getExecutionProfile(profileId, input.workspaceId, input.projectId);
  if (!profile) throw new ProfileNotFoundError();
  return profile;
}

export async function updateExecutionProfile(profileId: string, input: ProfileWriteInput): Promise<ExecutionProfile> {
  const name = input.name.trim();
  const existing = await sqlGet<{ id: string }>(
    `SELECT id FROM playwright_execution_profiles
      WHERE id = @profileId AND workspace_id = @workspaceId AND project_id = @projectId`,
    { profileId, workspaceId: input.workspaceId, projectId: input.projectId },
  );
  if (!existing) throw new ProfileNotFoundError();
  const duplicate = await sqlGet<{ id: string }>(
    `SELECT id FROM playwright_execution_profiles
      WHERE workspace_id = @workspaceId AND project_id = @projectId AND lower(name) = lower(@name) AND id <> @profileId`,
    { workspaceId: input.workspaceId, projectId: input.projectId, name, profileId },
  );
  if (duplicate) throw new ProfileNameConflictError(name);
  // Resolve before rewriting rows: "keep saved value" references read this profile's current data.
  const entries = await resolveTestDataEntries({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    entries: input.testData,
    keepSourceProfileId: profileId,
  });
  const now = nowIso();
  try {
    await withTransaction(async (client) => {
      await sqlRun(
        `UPDATE playwright_execution_profiles
            SET name = @name, base_url = @baseUrl, execution_notes = @notes, screenshot_policy = @policy,
                headless = @headless, viewport_width = @viewportWidth, viewport_height = @viewportHeight,
                updated_by_user_id = @userId, updated_at = @now
          WHERE id = @profileId`,
        { profileId, name, baseUrl: input.baseUrl, notes: input.executionNotes, policy: input.screenshotPolicy,
          headless: input.headless, viewportWidth: input.viewportWidth, viewportHeight: input.viewportHeight,
          userId: input.userId, now },
        client,
      );
      await sqlRun(`DELETE FROM playwright_execution_profile_data WHERE profile_id = @profileId`, { profileId }, client);
      await insertProfileData(client, profileId, entries, now);
    });
  } catch (error) {
    // A concurrent create/rename can beat the pre-check; keep the friendly 409.
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      throw new ProfileNameConflictError(name);
    }
    throw error;
  }
  const profile = await getExecutionProfile(profileId, input.workspaceId, input.projectId);
  if (!profile) throw new ProfileNotFoundError();
  return profile;
}

export async function deleteExecutionProfile(profileId: string, workspaceId: string, projectId: string): Promise<boolean> {
  return (await sqlRun(
    `DELETE FROM playwright_execution_profiles
      WHERE id = @profileId AND workspace_id = @workspaceId AND project_id = @projectId`,
    { profileId, workspaceId, projectId },
  )) > 0;
}
