import "server-only";

import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret, maskSecret } from "@/modules/security/encryption.service";
import type { LLMProviderName } from "@/modules/llm/llm-types";

/**
 * Scoped, encrypted credential storage (ADR target: per-user secrets, never
 * shared, never returned raw). A user can only read/update their own credentials
 * — every function is keyed by (workspaceId, userId) resolved from the session,
 * never from client input. Workspace sync credentials are separate and used by
 * the Phase 4 worker.
 */

export type CredentialStatus = "not_configured" | "configured" | "invalid" | "expired";

export type CredentialSummary = {
  status: CredentialStatus;
  maskedPreview: string | null;
  provider?: string | null;
  lastValidatedAt?: string | null;
  isStale?: boolean;
};

export type UserCredentialStatus = {
  azurePat: CredentialSummary;
  llm: CredentialSummary & { model?: string | null };
};

/**
 * Days after which a successfully-stored credential is considered stale and the
 * user is nudged to re-validate it. Azure DevOps does not expose a PAT expiry
 * date, so staleness (age since last validation) is our proactive expiry signal.
 */
export const CREDENTIAL_STALE_DAYS = Number(process.env.CREDENTIAL_STALE_DAYS ?? 60);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Pure staleness check (unit-testable, no DB/clock dependency): true when
 * `lastValidatedAt` is more than `days` old relative to `nowIso`. A missing
 * timestamp is treated as not-stale (we have no basis to warn).
 */
export function isCredentialStale(
  lastValidatedAt: string | null | undefined,
  nowIso: string,
  days = CREDENTIAL_STALE_DAYS,
): boolean {
  if (!lastValidatedAt) return false;
  const validated = Date.parse(lastValidatedAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(validated) || Number.isNaN(now)) return false;
  return now - validated > days * MS_PER_DAY;
}

export type ResolvedUserLlm = {
  provider: LLMProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
};

type EncryptedRow = {
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
  key_version: number;
};

function decodeRow(row: EncryptedRow): string {
  return decryptSecret({
    ciphertext: row.encrypted_secret,
    iv: row.encryption_iv,
    tag: row.encryption_tag,
    keyVersion: row.key_version,
  });
}

// ── User Azure DevOps PAT ───────────────────────────────────────────────────

export async function storeUserAzurePat(input: {
  workspaceId: string;
  userId: string;
  pat: string;
  status?: CredentialStatus;
  lastValidatedAt?: string | null;
}): Promise<void> {
  const enc = encryptSecret(input.pat);
  const now = nowIso();
  await sqlRun(
    `INSERT INTO user_credentials (
       id, workspace_id, user_id, credential_type, provider,
       encrypted_secret, encryption_iv, encryption_tag, key_version,
       masked_preview, status, last_validated_at, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @userId, 'azure_pat', NULL,
       @ciphertext, @iv, @tag, @keyVersion,
       @masked, @status, @lastValidatedAt, @now, @now
     )
     ON CONFLICT (workspace_id, user_id, credential_type, COALESCE(provider, '')) DO UPDATE SET
       encrypted_secret = excluded.encrypted_secret,
       encryption_iv = excluded.encryption_iv,
       encryption_tag = excluded.encryption_tag,
       key_version = excluded.key_version,
       masked_preview = excluded.masked_preview,
       status = excluded.status,
       last_validated_at = excluded.last_validated_at,
       updated_at = excluded.updated_at`,
    {
      id: createId("cred"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      keyVersion: enc.keyVersion,
      masked: maskSecret(input.pat),
      status: input.status ?? "configured",
      lastValidatedAt: input.lastValidatedAt ?? null,
      now,
    },
  );
}

export async function resolveUserAzurePat(workspaceId: string, userId: string): Promise<string | null> {
  const row = await sqlGet<EncryptedRow>(
    `SELECT encrypted_secret, encryption_iv, encryption_tag, key_version
     FROM user_credentials
     WHERE workspace_id = @workspaceId AND user_id = @userId AND credential_type = 'azure_pat'
     LIMIT 1`,
    { workspaceId, userId },
  );
  return row ? decodeRow(row) : null;
}

/**
 * Flips the user's Azure PAT to `expired` after Azure rejects it at use-time
 * (a 401 from an interactive call). Idempotent — only writes when not already
 * expired. Called fire-and-forget from the adapter's onUnauthorized hook, so it
 * must never throw into the request path.
 */
export async function markUserAzurePatExpired(workspaceId: string, userId: string): Promise<void> {
  await sqlRun(
    `UPDATE user_credentials SET status = 'expired', updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @userId
       AND credential_type = 'azure_pat' AND status <> 'expired'`,
    { workspaceId, userId, now: nowIso() },
  );
}

// ── User LLM API key + personal settings ────────────────────────────────────

export async function storeUserLlmApiKey(input: {
  workspaceId: string;
  userId: string;
  provider: LLMProviderName;
  apiKey: string;
  status?: CredentialStatus;
  lastValidatedAt?: string | null;
}): Promise<void> {
  const enc = encryptSecret(input.apiKey);
  const now = nowIso();
  await sqlRun(
    `INSERT INTO user_credentials (
       id, workspace_id, user_id, credential_type, provider,
       encrypted_secret, encryption_iv, encryption_tag, key_version,
       masked_preview, status, last_validated_at, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @userId, 'llm_api_key', @provider,
       @ciphertext, @iv, @tag, @keyVersion,
       @masked, @status, @lastValidatedAt, @now, @now
     )
     ON CONFLICT (workspace_id, user_id, credential_type, COALESCE(provider, '')) DO UPDATE SET
       encrypted_secret = excluded.encrypted_secret,
       encryption_iv = excluded.encryption_iv,
       encryption_tag = excluded.encryption_tag,
       key_version = excluded.key_version,
       masked_preview = excluded.masked_preview,
       status = excluded.status,
       last_validated_at = excluded.last_validated_at,
       updated_at = excluded.updated_at`,
    {
      id: createId("cred"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      keyVersion: enc.keyVersion,
      masked: maskSecret(input.apiKey),
      status: input.status ?? "configured",
      lastValidatedAt: input.lastValidatedAt ?? null,
      now,
    },
  );
}

export async function saveUserLlmSettings(input: {
  workspaceId: string;
  userId: string;
  provider: LLMProviderName;
  model: string;
  baseUrl?: string | null;
  temperature?: number | null;
  maxOutputTokens?: number | null;
  isDefault?: boolean;
}): Promise<void> {
  const now = nowIso();
  const isDefault = input.isDefault ?? true;
  if (isDefault) {
    await sqlRun(
      `UPDATE user_llm_settings SET is_default = 0, updated_at = @now
       WHERE workspace_id = @workspaceId AND user_id = @userId`,
      { workspaceId: input.workspaceId, userId: input.userId, now },
    );
  }
  await sqlRun(
    `INSERT INTO user_llm_settings (
       id, workspace_id, user_id, provider, model, base_url, temperature,
       max_output_tokens, is_default, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @userId, @provider, @model, @baseUrl, @temperature,
       @maxOutputTokens, @isDefault, @now, @now
     )
     ON CONFLICT (workspace_id, user_id, provider) DO UPDATE SET
       model = excluded.model,
       base_url = excluded.base_url,
       temperature = excluded.temperature,
       max_output_tokens = excluded.max_output_tokens,
       is_default = excluded.is_default,
       updated_at = excluded.updated_at`,
    {
      id: createId("llmset"),
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl ?? null,
      temperature: input.temperature ?? null,
      maxOutputTokens: input.maxOutputTokens ?? null,
      isDefault: isDefault ? 1 : 0,
      now,
    },
  );
}

export async function updateUserLlmModel(input: {
  workspaceId: string;
  userId: string;
  provider: LLMProviderName;
  model: string;
}): Promise<void> {
  const now = nowIso();
  await sqlRun(
    `UPDATE user_llm_settings SET is_default = 0, updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @userId`,
    { workspaceId: input.workspaceId, userId: input.userId, now },
  );
  const updated = await sqlRun(
    `UPDATE user_llm_settings
     SET model = @model, is_default = 1, updated_at = @now
     WHERE workspace_id = @workspaceId AND user_id = @userId AND provider = @provider`,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      now,
    },
  );
  if (!updated) {
    await saveUserLlmSettings({
      workspaceId: input.workspaceId,
      userId: input.userId,
      provider: input.provider,
      model: input.model,
      isDefault: true,
    });
  }
}

/**
 * Resolves the caller's default LLM provider/model + decrypted API key for that
 * provider, or null when not fully configured. This is the per-user replacement
 * for the global runtime-settings LLM resolution.
 */
export async function resolveUserLlmConfig(workspaceId: string, userId: string): Promise<ResolvedUserLlm | null> {
  const settings = await sqlGet<{ provider: LLMProviderName; model: string; base_url: string | null }>(
    `SELECT provider, model, base_url
     FROM user_llm_settings
     WHERE workspace_id = @workspaceId AND user_id = @userId
     ORDER BY is_default DESC, updated_at DESC
     LIMIT 1`,
    { workspaceId, userId },
  );
  if (!settings) return null;

  const keyRow = await sqlGet<EncryptedRow>(
    `SELECT encrypted_secret, encryption_iv, encryption_tag, key_version
     FROM user_credentials
     WHERE workspace_id = @workspaceId AND user_id = @userId
       AND credential_type = 'llm_api_key' AND provider = @provider
     LIMIT 1`,
    { workspaceId, userId, provider: settings.provider },
  );
  if (!keyRow) return null;

  return {
    provider: settings.provider,
    model: settings.model,
    apiKey: decodeRow(keyRow),
    baseUrl: settings.base_url ?? undefined,
  };
}

// ── Masked status (safe for the frontend) ───────────────────────────────────

export async function getUserCredentialStatus(workspaceId: string, userId: string): Promise<UserCredentialStatus> {
  const now = nowIso();
  const pat = await sqlGet<{ masked_preview: string | null; status: string; last_validated_at: string | null }>(
    `SELECT masked_preview, status, last_validated_at
     FROM user_credentials
     WHERE workspace_id = @workspaceId AND user_id = @userId AND credential_type = 'azure_pat'
     LIMIT 1`,
    { workspaceId, userId },
  );
  const llm = await sqlGet<{
    masked_preview: string | null;
    status: string;
    provider: string | null;
    last_validated_at: string | null;
    model: string | null;
  }>(
    `SELECT c.masked_preview, c.status, c.provider, c.last_validated_at, s.model
     FROM user_credentials c
     LEFT JOIN user_llm_settings s
       ON s.workspace_id = c.workspace_id AND s.user_id = c.user_id AND s.provider = c.provider
     WHERE c.workspace_id = @workspaceId AND c.user_id = @userId AND c.credential_type = 'llm_api_key'
     ORDER BY s.is_default DESC NULLS LAST
     LIMIT 1`,
    { workspaceId, userId },
  );

  return {
    azurePat: pat
      ? {
          status: pat.status as CredentialStatus,
          maskedPreview: pat.masked_preview,
          lastValidatedAt: pat.last_validated_at,
          isStale: pat.status === "configured" && isCredentialStale(pat.last_validated_at, now),
        }
      : { status: "not_configured", maskedPreview: null },
    llm: llm
      ? {
          status: llm.status as CredentialStatus,
          maskedPreview: llm.masked_preview,
          provider: llm.provider,
          model: llm.model,
          lastValidatedAt: llm.last_validated_at,
          isStale: llm.status === "configured" && isCredentialStale(llm.last_validated_at, now),
        }
      : { status: "not_configured", maskedPreview: null },
  };
}

// ── Workspace sync credential (Phase 4 worker; stored now) ───────────────────

export async function storeWorkspaceSyncPat(input: {
  workspaceId: string;
  pat: string;
  createdByUserId: string;
  lastValidatedAt?: string | null;
}): Promise<void> {
  const enc = encryptSecret(input.pat);
  const now = nowIso();
  await sqlRun(
    `INSERT INTO workspace_credentials (
       id, workspace_id, credential_type, provider,
       encrypted_secret, encryption_iv, encryption_tag, key_version,
       masked_preview, created_by_user_id, last_validated_at, status, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, 'azure_pat', NULL,
       @ciphertext, @iv, @tag, @keyVersion,
       @masked, @createdByUserId, @lastValidatedAt, 'configured', @now, @now
     )
     ON CONFLICT (workspace_id, credential_type) DO UPDATE SET
       encrypted_secret = excluded.encrypted_secret,
       encryption_iv = excluded.encryption_iv,
       encryption_tag = excluded.encryption_tag,
       key_version = excluded.key_version,
       masked_preview = excluded.masked_preview,
       created_by_user_id = excluded.created_by_user_id,
       last_validated_at = excluded.last_validated_at,
       updated_at = excluded.updated_at`,
    {
      id: createId("wcred"),
      workspaceId: input.workspaceId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      keyVersion: enc.keyVersion,
      masked: maskSecret(input.pat),
      createdByUserId: input.createdByUserId,
      lastValidatedAt: input.lastValidatedAt ?? null,
      now,
    },
  );
}

export async function resolveWorkspaceSyncPat(workspaceId: string): Promise<string | null> {
  const row = await sqlGet<EncryptedRow>(
    `SELECT encrypted_secret, encryption_iv, encryption_tag, key_version
     FROM workspace_credentials
     WHERE workspace_id = @workspaceId AND credential_type = 'azure_pat'
     LIMIT 1`,
    { workspaceId },
  );
  return row ? decodeRow(row) : null;
}
