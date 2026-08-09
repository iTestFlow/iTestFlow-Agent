import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import type { AuthenticatedIdentity } from "./auth-provider";
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";

export type StoredUserIdentity = {
  id: string;
  azureIdentityId: string | null;
  emailOrUniqueName: string | null;
};

function normalizeIdentityValue(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized ? normalized : null;
}

export function authenticatedIdentityMatchesStoredUser(
  identity: AuthenticatedIdentity,
  user: StoredUserIdentity,
): boolean {
  const storedAzureIdentityId = normalizeIdentityValue(user.azureIdentityId);
  if (storedAzureIdentityId) {
    return storedAzureIdentityId === normalizeIdentityValue(identity.azureIdentityId);
  }

  return normalizeIdentityValue(user.emailOrUniqueName) === normalizeIdentityValue(identity.emailOrUniqueName);
}

export async function getStoredUserIdentity(userId: string): Promise<StoredUserIdentity | null> {
  const row = await sqlGet<{
    id: string;
    azure_identity_id: string | null;
    email_or_unique_name: string | null;
  }>(
    `SELECT id, azure_identity_id, email_or_unique_name
     FROM users
     WHERE id = @userId
     LIMIT 1`,
    { userId },
  );
  return row
    ? {
        id: row.id,
        azureIdentityId: row.azure_identity_id,
        emailOrUniqueName: row.email_or_unique_name,
      }
    : null;
}

/**
 * Batch-resolve user ids to human-readable names for read models (reports,
 * activity views, "approved by" lines). Falls back to the email/unique name
 * when a user has no display name; ids with no user row are simply absent
 * from the map, so callers keep their own last-resort fallback.
 */
export async function getUserDisplayNames(userIds: readonly string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(userIds.map((id) => id?.trim()).filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await sqlAll<{ id: string; display_name: string | null; email_or_unique_name: string | null }>(
    `SELECT id, display_name, email_or_unique_name FROM users WHERE id = ANY(@userIds)`,
    { userIds: uniqueIds },
  );
  const names = new Map<string, string>();
  for (const row of rows) {
    const name = row.display_name?.trim() || row.email_or_unique_name?.trim();
    if (name) names.set(row.id, name);
  }
  return names;
}

/**
 * User provisioning from an authenticated identity. Reconciles against both
 * unique keys (azure_identity_id and email_or_unique_name) so a bootstrapped
 * owner (created by email, no Azure identity yet) is upgraded in place on first
 * PAT login rather than colliding. Auto-provisioning policy (who may join a
 * workspace) is enforced by the caller.
 */
export async function provisionUserFromIdentity(identity: AuthenticatedIdentity): Promise<string> {
  const now = nowIso();
  const existing = await sqlGet<{ id: string }>(
    `SELECT id FROM users
     WHERE azure_identity_id = @azureId OR email_or_unique_name = @email
     ORDER BY (azure_identity_id = @azureId) DESC
     LIMIT 1`,
    { azureId: identity.azureIdentityId, email: identity.emailOrUniqueName },
  );

  if (existing) {
    await sqlRun(
      `UPDATE users
       SET display_name = @displayName,
           email_or_unique_name = @email,
           azure_identity_id = @azureId,
           status = 'active',
           last_login_at = @now
       WHERE id = @id`,
      {
        id: existing.id,
        displayName: identity.displayName,
        email: identity.emailOrUniqueName,
        azureId: identity.azureIdentityId,
        now,
      },
    );
    return existing.id;
  }

  const id = createId("user");
  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, azure_identity_id, status, created_at, last_login_at)
     VALUES (@id, @displayName, @email, @azureId, 'active', @now, @now)`,
    {
      id,
      displayName: identity.displayName,
      email: identity.emailOrUniqueName,
      azureId: identity.azureIdentityId,
      now,
    },
  );
  return id;
}

/** Ensures an active membership exists; never downgrades an existing role. */
export async function ensureWorkspaceMembership(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole = "member",
): Promise<void> {
  const now = nowIso();
  await sqlRun(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
     VALUES (@id, @workspaceId, @userId, @role, 'active', @now, @now)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    { id: createId("wm"), workspaceId, userId, role, now },
  );
}
