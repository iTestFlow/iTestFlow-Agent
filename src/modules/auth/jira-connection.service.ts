import "server-only";

import { createId, nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import { JiraBearerAuthError, type JiraAuth, type JiraTokenKind } from "@/modules/integrations/jira-cloud/jira-http";
import { AtlassianOAuthError, AtlassianReauthorizationRequiredError, refreshAtlassianOAuthTokens } from "./jira-oauth";

/**
 * Dual-kind Jira credential storage and resolution. A connection row is either
 * an api_token credential (email + encrypted Atlassian API token, Basic auth)
 * or an oauth credential (encrypted rotating access/refresh pair, Bearer
 * auth); the latest successful login or connect wins across kinds — the
 * upsert overwrites the discriminator and NULLs the other kind's secrets. The
 * failure states are kind-exclusive (schema-enforced): 'invalid' means a dead
 * API token replaced in Settings; 'reauthorization_required' means a dead
 * OAuth grant renewed through a fresh Atlassian consent. Both keep the
 * sync-principal flag and ciphertexts so recovery restores polling in place.
 */

export type StoreJiraConnectionInput = {
  workspaceId: string;
  userId: string;
  cloudId: string;
  email: string;
  isSyncPrincipal?: boolean;
} & (
  | { credentialKind?: "api_token"; apiToken: string; tokenKind: JiraTokenKind }
  | { credentialKind: "oauth"; accessToken: string; refreshToken: string; expiresInSeconds: number }
);

/**
 * The stored per-user Jira credential, resolved for one outbound call site.
 * The oauth arm exposes no token material: its async supplier reads (and when
 * needed, refreshes) the stored pair per request, so one credential can
 * outlive the ~1h access-token lifetime across a full sync drain.
 */
export type JiraCredential =
  | { kind: "api_token"; email: string; apiToken: string; tokenKind: JiraTokenKind; cloudId: string }
  | { kind: "oauth"; email: string; cloudId: string; getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string> };

/** Thrown when the stored token was marked invalid by a use-time 401. */
export class InvalidJiraCredentialsError extends Error {
  constructor() {
    super("The stored Jira API token is invalid. Replace it in Settings → Jira Cloud.");
    this.name = "InvalidJiraCredentialsError";
  }
}

/** Thrown when the stored OAuth grant is dead; only a fresh Atlassian consent recovers it. */
export class JiraReauthorizationRequiredError extends Error {
  constructor() {
    super("The Jira connection needs to be renewed. Reconnect with Atlassian in Settings → Jira Cloud.");
    this.name = "JiraReauthorizationRequiredError";
  }
}

export type JiraSyncPrincipalErrorCode =
  | "jira_sync_principal_missing"
  | "jira_sync_principal_invalid"
  | "jira_sync_principal_reauthorization_required";

export class JiraSyncPrincipalError extends Error {
  readonly code: JiraSyncPrincipalErrorCode;
  constructor(code: JiraSyncPrincipalErrorCode) {
    super(code === "jira_sync_principal_missing"
      ? "No active Jira sync principal is configured for this workspace."
      : code === "jira_sync_principal_invalid"
        ? "The Jira sync principal's API token is invalid. The sync owner must replace it in Settings."
        : "The Jira sync principal's Atlassian authorization expired. The sync owner must reconnect with Atlassian in Settings.");
    this.name = "JiraSyncPrincipalError";
    this.code = code;
  }
}

export async function storeJiraConnection(input: StoreJiraConnectionInput): Promise<void> {
  const workspaceId = input.workspaceId.trim();
  const userId = input.userId.trim();
  const cloudId = input.cloudId.trim();
  const email = input.email.trim().toLowerCase();
  const isOAuth = input.credentialKind === "oauth";
  const secretsPresent = isOAuth
    ? Boolean(input.accessToken.trim() && input.refreshToken.trim() && input.expiresInSeconds > 0)
    : Boolean(input.apiToken.trim());
  if (!workspaceId || !userId || !cloudId || !email || !secretsPresent) {
    throw new Error("Jira connection fields are required.");
  }
  // Encryption happens before the transaction opens so the lock window stays
  // minimal. Every secret column of the OTHER kind is written NULL: that is
  // what makes the upsert latest-wins across kinds under the schema's
  // kind-hygiene CHECK.
  const token = isOAuth ? null : encryptSecret(input.apiToken);
  const access = isOAuth ? encryptSecret(input.accessToken) : null;
  const refresh = isOAuth ? encryptSecret(input.refreshToken) : null;
  if (access && refresh && access.keyVersion !== refresh.keyVersion) {
    throw new Error("Jira OAuth token encryption key versions do not match.");
  }
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
      // one-active-principal partial unique index. An INVALID or
      // reauthorization-required principal keeps its flag (it does not appear
      // here), so replacing its credential through this upsert restores
      // polling without a principal handover.
      isSyncPrincipal = !otherPrincipal;
    }

    const written = await sqlRun(
      `INSERT INTO jira_connections (
         id, workspace_id, user_id, cloud_id, email, credential_kind, token_kind,
         encrypted_api_token, api_token_iv, api_token_tag,
         encrypted_access_token, access_token_iv, access_token_tag,
         encrypted_refresh_token, refresh_token_iv, refresh_token_tag,
         access_expires_at, key_version,
         status, is_sync_principal, last_validated_at, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @userId, @cloudId, @email, @credentialKind, @tokenKind,
         @encryptedApiToken, @apiTokenIv, @apiTokenTag,
         @encryptedAccessToken, @accessTokenIv, @accessTokenTag,
         @encryptedRefreshToken, @refreshTokenIv, @refreshTokenTag,
         @accessExpiresAt, @keyVersion,
         'active', @isSyncPrincipal, @now, @now, @now
       )
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         cloud_id = excluded.cloud_id,
         email = excluded.email,
         credential_kind = excluded.credential_kind,
         token_kind = excluded.token_kind,
         encrypted_api_token = excluded.encrypted_api_token,
         api_token_iv = excluded.api_token_iv,
         api_token_tag = excluded.api_token_tag,
         encrypted_access_token = excluded.encrypted_access_token,
         access_token_iv = excluded.access_token_iv,
         access_token_tag = excluded.access_token_tag,
         encrypted_refresh_token = excluded.encrypted_refresh_token,
         refresh_token_iv = excluded.refresh_token_iv,
         refresh_token_tag = excluded.refresh_token_tag,
         access_expires_at = excluded.access_expires_at,
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
        credentialKind: isOAuth ? "oauth" : "api_token",
        tokenKind: isOAuth ? null : input.tokenKind,
        encryptedApiToken: token?.ciphertext ?? null,
        apiTokenIv: token?.iv ?? null,
        apiTokenTag: token?.tag ?? null,
        encryptedAccessToken: access?.ciphertext ?? null,
        accessTokenIv: access?.iv ?? null,
        accessTokenTag: access?.tag ?? null,
        encryptedRefreshToken: refresh?.ciphertext ?? null,
        refreshTokenIv: refresh?.iv ?? null,
        refreshTokenTag: refresh?.tag ?? null,
        accessExpiresAt: isOAuth ? expiryIso(now, input.expiresInSeconds) : null,
        keyVersion: (token ?? access)!.keyVersion,
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
  credential_kind: "api_token" | "oauth";
  token_kind: JiraTokenKind | null;
  cloud_id: string;
  status: "active" | "invalid" | "reauthorization_required";
  encrypted_api_token: string | null;
  api_token_iv: string | null;
  api_token_tag: string | null;
  key_version: number | null;
};

const RESOLVE_COLUMNS = `c.user_id, c.email, c.credential_kind, c.token_kind, c.cloud_id, c.status,
            c.encrypted_api_token, c.api_token_iv, c.api_token_tag, c.key_version`;

/**
 * Resolve the caller's stored Jira credential. A plain read — API tokens never
 * rotate at use time, and the oauth arm defers all token work to its supplier,
 * so this takes no row locks and never serializes concurrent Jira traffic.
 */
export async function resolveJiraCredentials(input: { workspaceId: string; userId: string }): Promise<JiraCredential> {
  const row = await sqlGet<JiraConnectionRow>(
    `SELECT ${RESOLVE_COLUMNS}
     FROM jira_connections c
     JOIN workspaces w ON w.id = c.workspace_id AND w.status = 'active'
     JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.status = 'active'
     WHERE c.workspace_id = @workspaceId AND c.user_id = @userId
       AND c.status IN ('active', 'invalid', 'reauthorization_required')
     LIMIT 1`,
    { workspaceId: input.workspaceId, userId: input.userId },
  );
  if (!row) throw new Error("No active Jira connection is available for this user and workspace.");
  assertUsableStatus(row.status);
  return toCredential(row, input.workspaceId);
}

/**
 * Resolve the single owner/admin connection designated for background Jira
 * synchronization, distinguishing "never configured" from the two dead-
 * credential states so job failures carry an actionable code. A non-active
 * principal keeps its flag: replacing the credential reactivates polling
 * without a handover.
 */
export async function resolveJiraSyncPrincipalCredentials(
  workspaceId: string,
): Promise<JiraCredential & { userId: string }> {
  const row = await sqlGet<JiraConnectionRow>(
    `SELECT ${RESOLVE_COLUMNS}
     FROM jira_connections c
     JOIN workspaces w ON w.id = c.workspace_id
     JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id
     WHERE c.workspace_id = @workspaceId AND c.is_sync_principal = true
       AND c.status IN ('active', 'invalid', 'reauthorization_required')
       AND w.status = 'active' AND w.provider_id = 'jira-cloud'
       AND m.status = 'active' AND m.role IN ('owner', 'admin')
     ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END
     LIMIT 1`,
    { workspaceId },
  );
  if (!row) throw new JiraSyncPrincipalError("jira_sync_principal_missing");
  if (row.status === "invalid") throw new JiraSyncPrincipalError("jira_sync_principal_invalid");
  if (row.status === "reauthorization_required") throw new JiraSyncPrincipalError("jira_sync_principal_reauthorization_required");
  return { userId: row.user_id, ...toCredential(row, workspaceId) };
}

/** The dead-credential states are kind-exclusive, so each maps to exactly one typed error. */
function assertUsableStatus(status: JiraConnectionRow["status"]): void {
  if (status === "invalid") throw new InvalidJiraCredentialsError();
  if (status === "reauthorization_required") throw new JiraReauthorizationRequiredError();
}

function toCredential(row: JiraConnectionRow, workspaceId: string): JiraCredential {
  if (row.credential_kind === "oauth") {
    return {
      kind: "oauth",
      email: row.email,
      cloudId: row.cloud_id,
      getAccessToken: createOAuthAccessTokenSupplier({ workspaceId, userId: row.user_id }),
    };
  }
  if (!row.token_kind || !row.encrypted_api_token || !row.api_token_iv || !row.api_token_tag || row.key_version === null) {
    throw new Error("The stored Jira connection is missing its encrypted token.");
  }
  return {
    kind: "api_token",
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

/** Refresh when the access token has less life left than one slow request could need. */
const ACCESS_REFRESH_THRESHOLD_MS = 60_000;

type OAuthTokenRow = {
  id: string;
  status: "active" | "invalid" | "reauthorization_required";
  encrypted_access_token: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  encrypted_refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  key_version: number | null;
  access_expires_at: string | null;
};

/**
 * Async bearer supplier for one resolved OAuth connection — the single owner
 * of use-time refresh. Fast path: a lock-free read serves a stored token with
 * >60s of life. Refresh path: a SELECT ... FOR UPDATE transaction re-checks
 * inside the lock (single-flight collapse — a concurrent flight's rotation is
 * reused, never repeated), calls the token endpoint, and persists the rotated
 * pair atomically with its expiry; the new refresh token is never observable
 * without its access token. A terminal refresh flips the row to
 * reauthorization_required in the same transaction — keeping the
 * sync-principal flag and ciphertexts, mirroring the invalid lifecycle — via
 * a sentinel return, because throwing would roll the flip back. Transient
 * failures leave the row untouched. The supplier remembers the expiry it last
 * served: a forceRefresh whose stored expiry has already moved means another
 * flight rotated meanwhile, so the fresh stored token is served instead of
 * burning a second rotation. All failures leave as JiraBearerAuthError, the
 * vocabulary jiraFetch classifies.
 */
function createOAuthAccessTokenSupplier(key: { workspaceId: string; userId: string }): (options?: { forceRefresh?: boolean }) => Promise<string> {
  let lastServedExpiresAt: string | null = null;
  return async (options?: { forceRefresh?: boolean }): Promise<string> => {
    try {
      const served = await resolveOAuthAccessToken(key, options?.forceRefresh === true, lastServedExpiresAt);
      lastServedExpiresAt = served.expiresAt;
      return served.accessToken;
    } catch (error) {
      if (error instanceof JiraReauthorizationRequiredError || error instanceof AtlassianReauthorizationRequiredError) {
        throw new JiraBearerAuthError("reauthorization_required");
      }
      if (error instanceof AtlassianOAuthError) {
        throw new JiraBearerAuthError("unavailable");
      }
      throw error;
    }
  };
}

async function resolveOAuthAccessToken(
  key: { workspaceId: string; userId: string },
  forceRefresh: boolean,
  lastServedExpiresAt: string | null,
): Promise<{ accessToken: string; expiresAt: string }> {
  if (!forceRefresh) {
    const row = await readOAuthTokenRow(key, undefined, false);
    const fresh = usableOAuthRow(row);
    if (msUntilExpiry(fresh) > ACCESS_REFRESH_THRESHOLD_MS) {
      return { accessToken: decryptOAuthSecret(fresh, "access"), expiresAt: fresh.access_expires_at! };
    }
  }
  const outcome = await withTransaction(async (client) => {
    const row = usableOAuthRow(await readOAuthTokenRow(key, client, true));
    // Single-flight collapse inside the lock: the token is fresh AND (for a
    // forced refresh) is not the one this supplier served into the 401 —
    // another flight already rotated it.
    const rotatedElsewhere = forceRefresh
      ? row.access_expires_at !== lastServedExpiresAt && msUntilExpiry(row) > ACCESS_REFRESH_THRESHOLD_MS
      : msUntilExpiry(row) > ACCESS_REFRESH_THRESHOLD_MS;
    if (rotatedElsewhere) {
      return { accessToken: decryptOAuthSecret(row, "access"), expiresAt: row.access_expires_at! };
    }
    let rotated;
    try {
      rotated = await refreshAtlassianOAuthTokens(decryptOAuthSecret(row, "refresh"));
    } catch (error) {
      if (error instanceof AtlassianReauthorizationRequiredError) {
        await sqlRun(
          `UPDATE jira_connections SET status = 'reauthorization_required', updated_at = @now
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
    const expiresAt = expiryIso(now, rotated.expiresInSeconds);
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
        accessExpiresAt: expiresAt,
        now,
      },
      client,
    );
    return { accessToken: rotated.accessToken, expiresAt };
  });
  if ("reauthorizationRequired" in outcome) throw new JiraReauthorizationRequiredError();
  return outcome;
}

async function readOAuthTokenRow(
  key: { workspaceId: string; userId: string },
  client: Parameters<Parameters<typeof withTransaction>[0]>[0] | undefined,
  forUpdate: boolean,
): Promise<OAuthTokenRow | undefined> {
  return await sqlGet<OAuthTokenRow>(
    `SELECT c.id, c.status,
            c.encrypted_access_token, c.access_token_iv, c.access_token_tag,
            c.encrypted_refresh_token, c.refresh_token_iv, c.refresh_token_tag,
            c.key_version, c.access_expires_at
     FROM jira_connections c
     JOIN workspaces w ON w.id = c.workspace_id AND w.status = 'active'
     JOIN workspace_members m ON m.workspace_id = c.workspace_id AND m.user_id = c.user_id AND m.status = 'active'
     WHERE c.workspace_id = @workspaceId AND c.user_id = @userId
       AND c.credential_kind = 'oauth'
       AND c.status IN ('active', 'reauthorization_required')
     LIMIT 1${forUpdate ? "\n     FOR UPDATE OF c" : ""}`,
    { workspaceId: key.workspaceId, userId: key.userId },
    client,
  );
}

function usableOAuthRow(row: OAuthTokenRow | undefined): OAuthTokenRow {
  if (!row) throw new Error("No active Jira connection is available for this user and workspace.");
  if (row.status === "reauthorization_required") throw new JiraReauthorizationRequiredError();
  return row;
}

function decryptOAuthSecret(row: OAuthTokenRow, which: "access" | "refresh"): string {
  const parts = which === "access"
    ? { ciphertext: row.encrypted_access_token, iv: row.access_token_iv, tag: row.access_token_tag }
    : { ciphertext: row.encrypted_refresh_token, iv: row.refresh_token_iv, tag: row.refresh_token_tag };
  if (!parts.ciphertext || !parts.iv || !parts.tag || row.key_version === null || !row.access_expires_at) {
    throw new Error("The stored Jira connection is missing its encrypted OAuth tokens.");
  }
  return decryptSecret({ ciphertext: parts.ciphertext, iv: parts.iv, tag: parts.tag, keyVersion: row.key_version });
}

function msUntilExpiry(row: OAuthTokenRow): number {
  if (!row.access_expires_at) return 0;
  return Date.parse(row.access_expires_at) - Date.parse(nowIso());
}

function expiryIso(now: string, expiresInSeconds: number): string {
  return new Date(Date.parse(now) + expiresInSeconds * 1000).toISOString();
}

/**
 * Use-time invalidation (mirrors the Azure PAT expiry hook): a plain 401 from
 * Atlassian flips an api_token connection to 'invalid'. The sync-principal
 * flag and the encrypted token are KEPT so a replaced token restores polling
 * in place; only revocation clears them. Kind-guarded: the schema forbids
 * 'invalid' on oauth rows, whose 401s route through the refresh path and
 * {@link markJiraConnectionReauthorizationRequired}. Idempotent and safe to
 * fire-and-forget.
 */
export async function markJiraConnectionInvalid(workspaceId: string, userId: string): Promise<void> {
  await sqlRun(
    `UPDATE jira_connections SET status = 'invalid', updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @userId
       AND credential_kind = 'api_token' AND status = 'active'`,
    { workspaceId, userId, now: nowIso() },
  );
}

/**
 * The oauth mirror of {@link markJiraConnectionInvalid}: a bearer 401 that
 * survived a forced refresh means the grant is dead. Flag and ciphertexts are
 * KEPT — a fresh Atlassian consent through the same upsert restores polling
 * without a principal handover.
 */
export async function markJiraConnectionReauthorizationRequired(workspaceId: string, userId: string): Promise<void> {
  await sqlRun(
    `UPDATE jira_connections SET status = 'reauthorization_required', updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @userId
       AND credential_kind = 'oauth' AND status = 'active'`,
    { workspaceId, userId, now: nowIso() },
  );
}

/**
 * Adapter settings fragment for a resolved credential — the one place the
 * credential union maps onto {@code JiraCloudSettings}' auth arms.
 */
export function jiraCredentialSettings(credential: JiraCredential):
  | { credentialKind?: "api_token"; email: string; apiToken: string; tokenKind: JiraTokenKind }
  | { credentialKind: "oauth"; getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string> } {
  return credential.kind === "oauth"
    ? { credentialKind: "oauth", getAccessToken: credential.getAccessToken }
    : { email: credential.email, apiToken: credential.apiToken, tokenKind: credential.tokenKind };
}

/**
 * Kind-aware use-time 401 hook: token 401s invalidate; bearer 401s that
 * survived a forced refresh mark reauthorization required. Fire-and-forget —
 * never blocks or fails the in-flight request.
 */
export function jiraOnUnauthorized(credential: JiraCredential, workspaceId: string, userId: string): { onUnauthorized: () => void } {
  return {
    onUnauthorized: () => {
      const flip = credential.kind === "oauth" ? markJiraConnectionReauthorizationRequired : markJiraConnectionInvalid;
      void flip(workspaceId, userId).catch(() => {});
    },
  };
}

export type JiraAuthCredential = JiraAuth;

export async function revokeJiraConnection(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId?: string;
}): Promise<void> {
  const targetUserId = input.targetUserId ?? input.actorUserId;
  const revoked = await sqlRun(
    `UPDATE jira_connections SET
       status = 'revoked', is_sync_principal = false,
       encrypted_api_token = NULL, api_token_iv = NULL, api_token_tag = NULL,
       encrypted_access_token = NULL, access_token_iv = NULL, access_token_tag = NULL,
       encrypted_refresh_token = NULL, refresh_token_iv = NULL, refresh_token_tag = NULL,
       access_expires_at = NULL, key_version = NULL,
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
