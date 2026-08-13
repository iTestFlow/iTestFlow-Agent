import "server-only";

import { createId, nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import {
  AtlassianReauthorizationRequiredError,
  isAllowedAtlassianCloudId,
  refreshAtlassianOAuthTokens,
} from "./jira-oauth";

export type StoreJiraConnectionInput = {
  workspaceId: string;
  userId: string;
  cloudId: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string;
  isSyncPrincipal?: boolean;
};

export async function storeJiraConnection(input: StoreJiraConnectionInput): Promise<void> {
  const workspaceId = input.workspaceId.trim();
  const userId = input.userId.trim();
  const cloudId = input.cloudId.trim();
  const accessToken = input.accessToken;
  const refreshToken = input.refreshToken;
  const scopes = input.scopes.trim();
  if (!workspaceId || !userId || !cloudId || !accessToken.trim() || !refreshToken.trim() || !scopes) {
    throw new Error("Jira OAuth connection fields are required.");
  }
  if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
    throw new Error("Jira OAuth token expiry must be a positive integer.");
  }
  if (!isAllowedAtlassianCloudId(cloudId)) throw new Error("This Jira Cloud site is not approved.");
  const access = encryptSecret(accessToken);
  const refresh = encryptSecret(refreshToken);
  if (access.keyVersion !== refresh.keyVersion) throw new Error("Jira OAuth token encryption key versions do not match.");
  const now = nowIso();
  const accessExpiresAt = new Date(Date.parse(now) + input.expiresInSeconds * 1000).toISOString();
  const written = await sqlRun(
    `INSERT INTO jira_connections (
       id, workspace_id, user_id, cloud_id,
       encrypted_access_token, access_token_iv, access_token_tag,
       encrypted_refresh_token, refresh_token_iv, refresh_token_tag, key_version,
       access_expires_at, scopes, status, is_sync_principal, created_at, updated_at
     )
     SELECT
       @id, @workspaceId, @userId, @cloudId,
       @encryptedAccessToken, @accessTokenIv, @accessTokenTag,
       @encryptedRefreshToken, @refreshTokenIv, @refreshTokenTag, @keyVersion,
       @accessExpiresAt, @scopes, 'active', @isSyncPrincipal, @now, @now
     FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @userId
     WHERE w.id = @workspaceId
       AND w.provider_id = 'jira-cloud'
       AND w.provider_site_id = @cloudId
       AND w.status = 'active'
       AND m.status = 'active'
       AND (@isSyncPrincipal = false OR m.role IN ('owner', 'admin'))
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       cloud_id = excluded.cloud_id,
       encrypted_access_token = excluded.encrypted_access_token,
       access_token_iv = excluded.access_token_iv,
       access_token_tag = excluded.access_token_tag,
       encrypted_refresh_token = excluded.encrypted_refresh_token,
       refresh_token_iv = excluded.refresh_token_iv,
       refresh_token_tag = excluded.refresh_token_tag,
       key_version = excluded.key_version,
       access_expires_at = excluded.access_expires_at,
       scopes = excluded.scopes,
       status = 'active',
       is_sync_principal = excluded.is_sync_principal,
       revoked_at = NULL,
       updated_at = excluded.updated_at`,
    {
      id: createId("jiraconn"),
      workspaceId,
      userId,
      cloudId,
      encryptedAccessToken: access.ciphertext,
      accessTokenIv: access.iv,
      accessTokenTag: access.tag,
      encryptedRefreshToken: refresh.ciphertext,
      refreshTokenIv: refresh.iv,
      refreshTokenTag: refresh.tag,
      keyVersion: access.keyVersion,
      accessExpiresAt,
      scopes,
      isSyncPrincipal: input.isSyncPrincipal ?? false,
      now,
    },
  );
  if (written !== 1) throw new Error("Jira connection is not authorized for this workspace and user.");
}

type JiraConnectionRow = {
  id: string;
  encrypted_access_token: string;
  access_token_iv: string;
  access_token_tag: string;
  encrypted_refresh_token: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  key_version: number;
  access_expires_at: string;
};

export async function resolveJiraAccessToken(input: { workspaceId: string; userId: string }): Promise<string> {
  const outcome = await withTransaction(async (client) => {
    const row = await sqlGet<JiraConnectionRow>(
      `SELECT c.id, c.encrypted_access_token, c.access_token_iv, c.access_token_tag,
              c.encrypted_refresh_token, c.refresh_token_iv, c.refresh_token_tag,
              c.key_version, c.access_expires_at
       FROM jira_connections c
       JOIN workspaces w ON w.id = c.workspace_id
       JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
       WHERE c.workspace_id = @workspaceId AND c.user_id = @userId
         AND c.status = 'active' AND w.status = 'active' AND m.status = 'active'
       FOR UPDATE`,
      { workspaceId: input.workspaceId, userId: input.userId },
      client,
    );
    if (!row) throw new Error("No active Jira connection is available for this user and workspace.");
    const refreshThreshold = Date.parse(nowIso()) + 60_000;
    if (Date.parse(row.access_expires_at) > refreshThreshold) {
      return decryptSecret({
        ciphertext: row.encrypted_access_token,
        iv: row.access_token_iv,
        tag: row.access_token_tag,
        keyVersion: row.key_version,
      });
    }
    const refreshToken = decryptSecret({
      ciphertext: row.encrypted_refresh_token,
      iv: row.refresh_token_iv,
      tag: row.refresh_token_tag,
      keyVersion: row.key_version,
    });
    let rotated;
    try {
      rotated = await refreshAtlassianOAuthTokens(refreshToken);
    } catch (error) {
      if (error instanceof AtlassianReauthorizationRequiredError) {
        await sqlRun(
          `UPDATE jira_connections SET status = 'reauthorization_required', is_sync_principal = false, updated_at = @now
           WHERE id = @id AND status = 'active'`,
          { id: row.id, now: nowIso() },
          client,
        );
        return { reauthorizationRequired: true as const };
      }
      throw error;
    }
    const access = encryptSecret(rotated.accessToken);
    const refresh = encryptSecret(rotated.refreshToken);
    if (access.keyVersion !== refresh.keyVersion) throw new Error("Jira OAuth token encryption key versions do not match.");
    const now = nowIso();
    await sqlRun(
      `UPDATE jira_connections SET
         encrypted_access_token = @encryptedAccessToken,
         access_token_iv = @accessTokenIv,
         access_token_tag = @accessTokenTag,
         encrypted_refresh_token = @encryptedRefreshToken,
         refresh_token_iv = @refreshTokenIv,
         refresh_token_tag = @refreshTokenTag,
         key_version = @keyVersion,
         access_expires_at = @accessExpiresAt,
         scopes = @scopes,
         updated_at = @now
       WHERE id = @id AND status = 'active'`,
      {
        id: row.id,
        encryptedAccessToken: access.ciphertext,
        accessTokenIv: access.iv,
        accessTokenTag: access.tag,
        encryptedRefreshToken: refresh.ciphertext,
        refreshTokenIv: refresh.iv,
        refreshTokenTag: refresh.tag,
        keyVersion: access.keyVersion,
        accessExpiresAt: new Date(Date.parse(now) + rotated.expiresInSeconds * 1000).toISOString(),
        scopes: rotated.scope,
        now,
      },
      client,
    );
    return { accessToken: rotated.accessToken };
  });
  if (typeof outcome === "string") return outcome;
  if ("reauthorizationRequired" in outcome) {
    throw new AtlassianReauthorizationRequiredError();
  }
  return outcome.accessToken;
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
       encrypted_access_token = '', access_token_iv = '', access_token_tag = '',
       encrypted_refresh_token = '', refresh_token_iv = '', refresh_token_tag = '',
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
