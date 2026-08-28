import "server-only";

import { createId, nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import type { JiraTokenKind } from "@/modules/integrations/jira-cloud/jira-http";

export type StoreJiraConnectionInput = {
  workspaceId: string;
  userId: string;
  cloudId: string;
  email: string;
  apiToken: string;
  tokenKind: JiraTokenKind;
  isSyncPrincipal?: boolean;
};

/** The stored per-user Jira credential, resolved for one outbound call site. */
export type JiraCredentials = {
  email: string;
  apiToken: string;
  tokenKind: JiraTokenKind;
  cloudId: string;
};

/** Thrown when the stored token was marked invalid by a use-time 401. */
export class InvalidJiraCredentialsError extends Error {
  constructor() {
    super("The stored Jira API token is invalid. Replace it in Settings → Jira Cloud.");
    this.name = "InvalidJiraCredentialsError";
  }
}

export type JiraSyncPrincipalErrorCode = "jira_sync_principal_missing" | "jira_sync_principal_invalid";

export class JiraSyncPrincipalError extends Error {
  readonly code: JiraSyncPrincipalErrorCode;
  constructor(code: JiraSyncPrincipalErrorCode) {
    super(code === "jira_sync_principal_missing"
      ? "No active Jira sync principal is configured for this workspace."
      : "The Jira sync principal's API token is invalid. The sync owner must replace it in Settings.");
    this.name = "JiraSyncPrincipalError";
    this.code = code;
  }
}

export async function storeJiraConnection(input: StoreJiraConnectionInput): Promise<void> {
  const workspaceId = input.workspaceId.trim();
  const userId = input.userId.trim();
  const cloudId = input.cloudId.trim();
  const email = input.email.trim().toLowerCase();
  if (!workspaceId || !userId || !cloudId || !email || !input.apiToken.trim()) {
    throw new Error("Jira connection fields are required.");
  }
  const token = encryptSecret(input.apiToken);
  const now = nowIso();
  const requestedSyncPrincipal = input.isSyncPrincipal ?? false;
  await withTransaction(async (client) => {
    // Every principal decision for a workspace begins with the same parent-row
    // lock. Different owners therefore serialize before inspecting the partial
    // unique-index predicate, while the membership row keeps authorization
    // atomic with the write. The workspace binding (provider_site_id) rejects a
    // connection for any cloud ID other than the workspace's pinned one.
    const authorized = await sqlGet<{ role: "owner" | "admin" | "member" }>(
      `SELECT m.role
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @userId
       WHERE w.id = @workspaceId
         AND w.provider_id = 'jira-cloud'
         AND w.provider_site_id = @cloudId
         AND w.status = 'active'
         AND m.status = 'active'
         AND (@isSyncPrincipal = false OR m.role IN ('owner', 'admin'))
       FOR UPDATE OF w, m`,
      { workspaceId, userId, cloudId, isSyncPrincipal: requestedSyncPrincipal },
      client,
    );
    if (!authorized) throw new Error("Jira connection is not authorized for this workspace and user.");

    let isSyncPrincipal = requestedSyncPrincipal;
    if (requestedSyncPrincipal) {
      const otherPrincipal = await sqlGet<{ id: string }>(
        `SELECT other.id
         FROM jira_connections other
         WHERE other.workspace_id = @workspaceId
           AND other.user_id <> @userId
           AND other.is_sync_principal = true
           AND other.status = 'active'
         ORDER BY other.id ASC
         LIMIT 1
         FOR UPDATE`,
        { workspaceId, userId },
        client,
      );
      // Bootstrap-seeded workspaces may have multiple owners. The first active
      // principal remains designated; later owners yield without violating the
      // one-active-principal partial unique index. An INVALID principal keeps
      // its flag (it does not appear here), so replacing its token through this
      // upsert restores polling without a principal handover.
      isSyncPrincipal = !otherPrincipal;
    }

    const written = await sqlRun(
      `INSERT INTO jira_connections (
         id, workspace_id, user_id, cloud_id, email, token_kind,
         encrypted_api_token, api_token_iv, api_token_tag, key_version,
         status, is_sync_principal, last_validated_at, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @userId, @cloudId, @email, @tokenKind,
         @encryptedApiToken, @apiTokenIv, @apiTokenTag, @keyVersion,
         'active', @isSyncPrincipal, @now, @now, @now
       )
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         cloud_id = excluded.cloud_id,
         email = excluded.email,
         token_kind = excluded.token_kind,
         encrypted_api_token = excluded.encrypted_api_token,
         api_token_iv = excluded.api_token_iv,
         api_token_tag = excluded.api_token_tag,
         key_version = excluded.key_version,
         status = 'active',
         is_sync_principal = excluded.is_sync_principal,
         last_validated_at = excluded.last_validated_at,
         revoked_at = NULL,
         updated_at = excluded.updated_at`,
      {
        id: createId("jiraconn"),
        workspaceId,
        userId,
        cloudId,
        email,
        tokenKind: input.tokenKind,
        encryptedApiToken: token.ciphertext,
        apiTokenIv: token.iv,
        apiTokenTag: token.tag,
        keyVersion: token.keyVersion,
        isSyncPrincipal,
        now,
      },
      client,
    );
    if (written !== 1) throw new Error("Jira connection is not authorized for this workspace and user.");
  });
}

type JiraConnectionRow = {
  user_id: string;
  email: string;
  token_kind: JiraTokenKind;
  cloud_id: string;
  status: "active" | "invalid";
  encrypted_api_token: string | null;
  api_token_iv: string | null;
  api_token_tag: string | null;
  key_version: number | null;
};

/**
 * Resolve the caller's stored Jira credential. A plain read — API tokens never
 * rotate at use time, so unlike the OAuth-era resolver this takes no row locks
 * and never serializes concurrent Jira traffic.
 */
export async function resolveJiraCredentials(input: { workspaceId: string; userId: string }): Promise<JiraCredentials> {
  const row = await sqlGet<JiraConnectionRow>(
    `SELECT c.user_id, c.email, c.token_kind, c.cloud_id, c.status,
            c.encrypted_api_token, c.api_token_iv, c.api_token_tag, c.key_version
     FROM jira_connections c
     JOIN workspaces w ON w.id = c.workspace_id AND w.status = 'active'
     JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.status = 'active'
     WHERE c.workspace_id = @workspaceId AND c.user_id = @userId
       AND c.status IN ('active', 'invalid')
     LIMIT 1`,
    { workspaceId: input.workspaceId, userId: input.userId },
  );
  if (!row) throw new Error("No active Jira connection is available for this user and workspace.");
  if (row.status === "invalid") throw new InvalidJiraCredentialsError();
  return decryptCredentials(row);
}

/**
 * Resolve the single owner/admin connection designated for background Jira
 * synchronization, distinguishing "never configured" from "invalid token" so
 * job failures can carry an actionable code. An invalid principal keeps its
 * flag: replacing the token reactivates polling without a handover.
 */
export async function resolveJiraSyncPrincipalCredentials(
  workspaceId: string,
): Promise<JiraCredentials & { userId: string }> {
  const row = await sqlGet<JiraConnectionRow>(
    `SELECT c.user_id, c.email, c.token_kind, c.cloud_id, c.status,
            c.encrypted_api_token, c.api_token_iv, c.api_token_tag, c.key_version
     FROM jira_connections c
     JOIN workspaces w ON w.id = c.workspace_id
     JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
     WHERE c.workspace_id = @workspaceId AND c.is_sync_principal = true
       AND c.status IN ('active', 'invalid')
       AND w.status = 'active' AND w.provider_id = 'jira-cloud'
       AND m.status = 'active' AND m.role IN ('owner', 'admin')
     ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END
     LIMIT 1`,
    { workspaceId },
  );
  if (!row) throw new JiraSyncPrincipalError("jira_sync_principal_missing");
  if (row.status === "invalid") throw new JiraSyncPrincipalError("jira_sync_principal_invalid");
  return { userId: row.user_id, ...decryptCredentials(row) };
}

/**
 * Use-time invalidation (mirrors the Azure PAT expiry hook): a plain 401 from
 * Atlassian flips the connection to 'invalid'. The sync-principal flag and the
 * encrypted token are KEPT so a replaced token restores polling in place; only
 * revocation clears them. Idempotent and safe to fire-and-forget.
 */
export async function markJiraConnectionInvalid(workspaceId: string, userId: string): Promise<void> {
  await sqlRun(
    `UPDATE jira_connections SET status = 'invalid', updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @userId AND status = 'active'`,
    { workspaceId, userId, now: nowIso() },
  );
}

export async function revokeJiraConnection(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId?: string;
}): Promise<void> {
  const targetUserId = input.targetUserId ?? input.actorUserId;
  const revoked = await sqlRun(
    `UPDATE jira_connections SET
       status = 'revoked', is_sync_principal = false,
       encrypted_api_token = NULL, api_token_iv = NULL, api_token_tag = NULL, key_version = NULL,
       revoked_at = @now, updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @targetUserId AND status <> 'revoked'
       AND EXISTS (
         SELECT 1 FROM workspaces w
         JOIN workspace_members actor ON actor.workspace_id = w.id AND actor.user_id = @actorUserId
         JOIN workspace_members target ON target.workspace_id = w.id AND target.user_id = @targetUserId
         WHERE w.id = @workspaceId AND w.provider_id = 'jira-cloud' AND w.status = 'active'
           AND actor.status = 'active' AND target.status = 'active'
           AND (
             @actorUserId = @targetUserId
             OR actor.role = 'owner'
             OR (actor.role = 'admin' AND target.role = 'member')
           )
       )`,
    {
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      targetUserId,
      now: nowIso(),
    },
  );
  if (revoked !== 1) throw new Error("Jira connection revocation is not authorized or the connection is unavailable.");
}

function decryptCredentials(row: JiraConnectionRow): JiraCredentials {
  if (!row.encrypted_api_token || !row.api_token_iv || !row.api_token_tag || row.key_version === null) {
    throw new Error("The stored Jira connection is missing its encrypted token.");
  }
  return {
    email: row.email,
    tokenKind: row.token_kind,
    cloudId: row.cloud_id,
    apiToken: decryptSecret({
      ciphertext: row.encrypted_api_token,
      iv: row.api_token_iv,
      tag: row.api_token_tag,
      keyVersion: row.key_version,
    }),
  };
}
