import "server-only";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { decryptSecret, encryptSecret, maskSecret } from "@/modules/security/encryption.service";
import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  createId,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";

import type {
  ApiEnvironmentConfig,
  DatabaseEnvironmentConfig,
  EnvironmentConfigInput,
  SecretInput,
  SecretPurpose,
} from "./schemas/test-execution.schemas";
import {
  ApiEnvironmentConfigSchema,
  DatabaseEnvironmentConfigSchema,
  EnvironmentConfigInputSchema,
} from "./schemas/test-execution.schemas";

/**
 * Environment profile CRUD. Secrets are write-only: stored AES-GCM encrypted,
 * surfaced exclusively as name + title + masked preview. Values re-enter the
 * system only inside the execution worker (run-persistence decrypts the
 * per-run snapshot copies).
 */

export type EnvironmentProfileView = {
  id: string;
  name: string;
  initialUrl: string;
  allowedOrigin: string;
  viewportWidth: number;
  viewportHeight: number;
  headless: boolean;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  evidenceLevel: "minimal" | "on_failure" | "all_steps";
  loginPlan: unknown;
  loginMode: "session" | "fresh";
  loggedInText: string;
  executionNotes: string;
  users: { handle: string; username: string; passwordSecretName: string | null; notes: string }[];
  api: ApiEnvironmentConfig | null;
  database: DatabaseEnvironmentConfig | null;
  lifecycleStatus: "active" | "archived";
  secrets: { secretName: string; title: string; maskedPreview: string; purpose: SecretPurpose }[];
  /** When a reusable login session was captured for this profile, if any. */
  sessionCapturedAt: string | null;
  updatedAt: string;
};

type ProfileRow = {
  id: string;
  name: string;
  initial_url: string | null;
  allowed_origin: string | null;
  viewport_width: number;
  viewport_height: number;
  headless: boolean;
  default_timeout_ms: number;
  navigation_timeout_ms: number;
  evidence_level: "minimal" | "on_failure" | "all_steps";
  login_plan_json: unknown;
  login_mode: "session" | "fresh";
  logged_in_text: string | null;
  execution_notes: string | null;
  users_json: unknown;
  api_config_json: unknown;
  db_config_json: unknown;
  lifecycle_status: "active" | "archived";
  session_captured_at: string | null;
  updated_at: string;
};

const PROFILE_COLUMNS = `p.id, p.name, p.initial_url, p.allowed_origin, p.viewport_width, p.viewport_height,
  p.headless, p.default_timeout_ms, p.navigation_timeout_ms, p.evidence_level, p.login_plan_json,
  p.login_mode, p.logged_in_text, p.execution_notes, p.users_json, p.api_config_json, p.db_config_json,
  p.lifecycle_status, p.updated_at,
  s.captured_at AS session_captured_at`;

const PROFILE_FROM = `test_environment_profiles p
  LEFT JOIN test_environment_sessions s ON s.profile_id = p.id`;

function scopeParams(scope: ProjectScope) {
  return { projectId: scope.projectId, azureProjectId: scope.azureProjectId };
}

async function loadSecretViews(profileIds: string[]): Promise<Map<string, EnvironmentProfileView["secrets"]>> {
  if (profileIds.length === 0) return new Map();
  const rows = await sqlAll<{
    profile_id: string;
    secret_name: string;
    title: string;
    masked_preview: string;
    purpose: SecretPurpose;
  }>(
    `SELECT profile_id, secret_name, title, masked_preview, purpose
     FROM test_environment_secrets WHERE profile_id = ANY(@profileIds) ORDER BY secret_name`,
    { profileIds },
  );
  const bySecret = new Map<string, EnvironmentProfileView["secrets"]>();
  for (const row of rows) {
    const list = bySecret.get(row.profile_id) ?? [];
    list.push({
      secretName: row.secret_name,
      title: row.title,
      maskedPreview: row.masked_preview,
      purpose: row.purpose,
    });
    bySecret.set(row.profile_id, list);
  }
  return bySecret;
}

function toView(row: ProfileRow, secrets: EnvironmentProfileView["secrets"]): EnvironmentProfileView {
  return {
    id: row.id,
    name: row.name,
    initialUrl: row.initial_url ?? "",
    allowedOrigin: row.allowed_origin ?? "",
    viewportWidth: row.viewport_width,
    viewportHeight: row.viewport_height,
    headless: row.headless,
    defaultTimeoutMs: row.default_timeout_ms,
    navigationTimeoutMs: row.navigation_timeout_ms,
    evidenceLevel: row.evidence_level,
    loginPlan: row.login_plan_json,
    loginMode: row.login_mode,
    loggedInText: row.logged_in_text ?? "",
    executionNotes: row.execution_notes ?? "",
    users: Array.isArray(row.users_json)
      ? (row.users_json as EnvironmentProfileView["users"]).map((user) => ({
          handle: String(user.handle ?? ""),
          username: String(user.username ?? ""),
          passwordSecretName: user.passwordSecretName ?? null,
          notes: String(user.notes ?? ""),
        }))
      : [],
    api: parseStoredConfig(row.api_config_json, "api"),
    database: parseStoredConfig(row.db_config_json, "database"),
    lifecycleStatus: row.lifecycle_status,
    secrets,
    sessionCapturedAt: row.session_captured_at,
    updatedAt: row.updated_at,
  };
}

export async function listEnvironmentProfiles(input: {
  workspaceId: string;
  scope: ProjectScope;
  includeArchived?: boolean;
}): Promise<EnvironmentProfileView[]> {
  const rows = await sqlAll<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM ${PROFILE_FROM}
     WHERE p.workspace_id = @workspaceId AND p.project_id = @projectId AND p.azure_project_id = @azureProjectId
       ${input.includeArchived ? "" : "AND p.lifecycle_status = 'active'"}
     ORDER BY p.updated_at DESC`,
    { workspaceId: input.workspaceId, ...scopeParams(input.scope) },
  );
  const secrets = await loadSecretViews(rows.map((row) => row.id));
  return rows.map((row) => toView(row, secrets.get(row.id) ?? []));
}

export async function getEnvironmentProfile(input: {
  workspaceId: string;
  scope: ProjectScope;
  environmentProfileId: string;
}): Promise<EnvironmentProfileView | null> {
  const row = await sqlGet<ProfileRow>(
    `SELECT ${PROFILE_COLUMNS} FROM ${PROFILE_FROM}
     WHERE p.id = @id AND p.workspace_id = @workspaceId AND p.project_id = @projectId AND p.azure_project_id = @azureProjectId`,
    { id: input.environmentProfileId, workspaceId: input.workspaceId, ...scopeParams(input.scope) },
  );
  if (!row) return null;
  const secrets = await loadSecretViews([row.id]);
  return toView(row, secrets.get(row.id) ?? []);
}

export class EnvironmentProfileNameConflictError extends Error {
  constructor() {
    super("An environment profile with this name already exists for the project.");
    this.name = "EnvironmentProfileNameConflictError";
  }
}

export const MAX_PROFILE_SECRETS = 30;

export class EnvironmentProfileSecretLimitError extends Error {
  constructor() {
    super(`An environment profile can hold at most ${MAX_PROFILE_SECRETS} credentials.`);
    this.name = "EnvironmentProfileSecretLimitError";
  }
}

export class EnvironmentProfileUpdateConflictError extends Error {
  constructor() {
    super("The environment profile changed while it was being updated. Refresh it and try again.");
    this.name = "EnvironmentProfileUpdateConflictError";
  }
}

export async function createEnvironmentProfile(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  config: EnvironmentConfigInput;
  secrets: SecretInput[];
}): Promise<EnvironmentProfileView> {
  const config = EnvironmentConfigInputSchema.parse(input.config);
  const id = createId("tenv");
  const now = nowIso();
  try {
    await withTransaction(async (client) => {
      await sqlRun(
        `INSERT INTO test_environment_profiles (
           id, workspace_id, project_id, azure_project_id, name, initial_url, allowed_origin,
           viewport_width, viewport_height, headless, default_timeout_ms, navigation_timeout_ms,
           evidence_level, login_plan_json, login_mode, logged_in_text, execution_notes, users_json,
           api_config_json, db_config_json,
           created_by, created_at, updated_at
         ) VALUES (
           @id, @workspaceId, @projectId, @azureProjectId, @name, @initialUrl, @allowedOrigin,
           @viewportWidth, @viewportHeight, @headless, @defaultTimeoutMs, @navigationTimeoutMs,
           @evidenceLevel, @loginPlanJson::jsonb, @loginMode, @loggedInText, @executionNotes, @usersJson::jsonb,
           @apiConfigJson::jsonb, @dbConfigJson::jsonb,
           @actor, @now, @now
         )`,
        {
          id,
          workspaceId: input.workspaceId,
          ...scopeParams(input.scope),
          name: config.name,
          initialUrl: config.initialUrl || null,
          allowedOrigin: config.allowedOrigin || null,
          viewportWidth: config.viewportWidth,
          viewportHeight: config.viewportHeight,
          headless: config.headless,
          defaultTimeoutMs: config.defaultTimeoutMs,
          navigationTimeoutMs: config.navigationTimeoutMs,
          evidenceLevel: config.evidenceLevel,
          loginPlanJson: config.loginPlan === null ? null : JSON.stringify(config.loginPlan),
          loginMode: config.loginMode,
          loggedInText: config.loggedInText || null,
          executionNotes: config.executionNotes || null,
          usersJson: JSON.stringify(config.users),
          apiConfigJson: config.api === null ? null : JSON.stringify(config.api),
          dbConfigJson: config.database === null ? null : JSON.stringify(config.database),
          actor: input.actor,
          now,
        },
        client,
      );
      for (const secret of input.secrets) {
        await insertProfileSecret(client, id, input.workspaceId, input.scope, secret, input.actor);
      }
    });
  } catch (error) {
    if (isUniqueViolation(error, "uq_test_environment_profiles_name")) {
      throw new EnvironmentProfileNameConflictError();
    }
    throw error;
  }

  writeAuditLog({
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    entityType: "test_environment_profile",
    entityId: id,
    action: "test_execution.environment_created",
    status: "Success",
    actor: input.actor,
    message: `Environment profile "${config.name}" created.`,
  });
  const view = await getEnvironmentProfile({ ...input, environmentProfileId: id });
  if (!view) throw new Error("Environment profile vanished after creation.");
  return view;
}

export async function updateEnvironmentProfile(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  environmentProfileId: string;
  config?: Partial<EnvironmentConfigInput>;
  upsertSecrets: SecretInput[];
  removeSecretNames: string[];
}): Promise<EnvironmentProfileView | null> {
  const existing = await getEnvironmentProfile(input);
  if (!existing) return null;

  // The create path caps a profile at MAX_PROFILE_SECRETS via its request
  // schema; the update schema only caps per-request, so enforce the
  // resulting total here.
  const resultingSecretNames = new Set([
    ...existing.secrets
      .map((secret) => secret.secretName)
      .filter((name) => !input.removeSecretNames.includes(name)),
    ...input.upsertSecrets.map((secret) => secret.secretName),
  ]);
  if (resultingSecretNames.size > MAX_PROFILE_SECRETS) {
    throw new EnvironmentProfileSecretLimitError();
  }

  try {
    let profileStillExists = true;
    await withTransaction(async (client) => {
      const locked = await sqlGet<{ updated_at: string }>(
        `SELECT updated_at FROM test_environment_profiles
         WHERE id = @id AND workspace_id = @workspaceId
           AND project_id = @projectId AND azure_project_id = @azureProjectId
         FOR UPDATE`,
        {
          id: input.environmentProfileId,
          workspaceId: input.workspaceId,
          ...scopeParams(input.scope),
        },
        client,
      );
      if (!locked) {
        profileStillExists = false;
        return;
      }
      if (locked.updated_at !== existing.updatedAt) {
        throw new EnvironmentProfileUpdateConflictError();
      }
      const updatedAt = nextProfileUpdatedAt(locked.updated_at);

      if (input.config && Object.keys(input.config).length > 0) {
        const merged = EnvironmentConfigInputSchema.parse({
          ...existing,
          ...renameConfigKeys(input.config),
        });
        await sqlRun(
          `UPDATE test_environment_profiles SET
             name = @name, initial_url = @initialUrl, allowed_origin = @allowedOrigin,
             viewport_width = @viewportWidth, viewport_height = @viewportHeight, headless = @headless,
             default_timeout_ms = @defaultTimeoutMs, navigation_timeout_ms = @navigationTimeoutMs,
             evidence_level = @evidenceLevel, login_plan_json = @loginPlanJson::jsonb,
             login_mode = @loginMode, logged_in_text = @loggedInText, execution_notes = @executionNotes,
             users_json = @usersJson::jsonb, api_config_json = @apiConfigJson::jsonb,
             db_config_json = @dbConfigJson::jsonb,
             updated_at = @now
           WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
          {
            id: input.environmentProfileId,
            workspaceId: input.workspaceId,
            ...scopeParams(input.scope),
            name: merged.name,
            initialUrl: merged.initialUrl || null,
            allowedOrigin: merged.allowedOrigin || null,
            viewportWidth: merged.viewportWidth,
            viewportHeight: merged.viewportHeight,
            headless: merged.headless,
            defaultTimeoutMs: merged.defaultTimeoutMs,
            navigationTimeoutMs: merged.navigationTimeoutMs,
            evidenceLevel: merged.evidenceLevel,
            loginPlanJson: merged.loginPlan === null || merged.loginPlan === undefined
              ? null
              : JSON.stringify(merged.loginPlan),
            loginMode: merged.loginMode ?? existing.loginMode,
            loggedInText: (merged.loggedInText ?? existing.loggedInText) || null,
            executionNotes: (merged.executionNotes ?? existing.executionNotes) || null,
            usersJson: JSON.stringify(merged.users ?? existing.users),
            apiConfigJson: merged.api === null ? null : JSON.stringify(merged.api),
            dbConfigJson: merged.database === null ? null : JSON.stringify(merged.database),
            now: updatedAt,
          },
          client,
        );
      } else if (input.upsertSecrets.length > 0 || input.removeSecretNames.length > 0) {
        // Secret rows and their reviewed profile version move together. Run
        // creation holds a share lock on this row while copying secrets.
        await sqlRun(
          `UPDATE test_environment_profiles SET updated_at = @updatedAt
           WHERE id = @id AND workspace_id = @workspaceId
             AND project_id = @projectId AND azure_project_id = @azureProjectId`,
          {
            id: input.environmentProfileId,
            workspaceId: input.workspaceId,
            ...scopeParams(input.scope),
            updatedAt,
          },
          client,
        );
      }
      for (const name of input.removeSecretNames) {
        await sqlRun(
          `DELETE FROM test_environment_secrets WHERE profile_id = @profileId AND secret_name = @name`,
          { profileId: input.environmentProfileId, name },
          client,
        );
      }
      for (const secret of input.upsertSecrets) {
        await sqlRun(
          `DELETE FROM test_environment_secrets WHERE profile_id = @profileId AND secret_name = @name`,
          { profileId: input.environmentProfileId, name: secret.secretName },
          client,
        );
        await insertProfileSecret(
          client,
          input.environmentProfileId,
          input.workspaceId,
          input.scope,
          secret,
          input.actor,
        );
      }
    });
    if (!profileStillExists) return null;
  } catch (error) {
    if (isUniqueViolation(error, "uq_test_environment_profiles_name")) {
      throw new EnvironmentProfileNameConflictError();
    }
    throw error;
  }

  writeAuditLog({
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    entityType: "test_environment_profile",
    entityId: input.environmentProfileId,
    action: "test_execution.environment_updated",
    status: "Success",
    actor: input.actor,
    message: `Environment profile updated (${input.upsertSecrets.length} secret(s) upserted, ${input.removeSecretNames.length} removed).`,
  });
  return getEnvironmentProfile(input);
}

function nextProfileUpdatedAt(previous: string): string {
  const candidate = nowIso();
  const previousMs = Date.parse(previous);
  const candidateMs = Date.parse(candidate);
  if (Number.isFinite(previousMs) && Number.isFinite(candidateMs) && candidateMs <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return candidate;
}

export async function archiveEnvironmentProfile(input: {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  environmentProfileId: string;
}): Promise<boolean> {
  const updated = await sqlRun(
    `UPDATE test_environment_profiles
     SET lifecycle_status = 'archived', archived_at = @now, archived_by = @actor, updated_at = @now
     WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId
       AND azure_project_id = @azureProjectId AND lifecycle_status = 'active'`,
    {
      id: input.environmentProfileId,
      workspaceId: input.workspaceId,
      ...scopeParams(input.scope),
      actor: input.actor,
      now: nowIso(),
    },
  );
  if (updated > 0) {
    writeAuditLog({
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
      azureOrganizationUrl: input.scope.azureOrganizationUrl,
      entityType: "test_environment_profile",
      entityId: input.environmentProfileId,
      action: "test_execution.environment_archived",
      status: "Success",
      actor: input.actor,
      message: "Environment profile archived.",
    });
  }
  return updated > 0;
}

async function insertProfileSecret(
  client: Parameters<typeof sqlRun>[2],
  profileId: string,
  workspaceId: string,
  scope: ProjectScope,
  secret: SecretInput,
  actor: string,
): Promise<void> {
  const encrypted = encryptSecret(secret.value);
  await sqlRun(
    `INSERT INTO test_environment_secrets (
       id, profile_id, workspace_id, project_id, azure_project_id, secret_name, title,
       purpose, encrypted_secret, encryption_iv, encryption_tag, key_version, masked_preview,
       created_by, created_at, updated_at
     ) VALUES (
       @id, @profileId, @workspaceId, @projectId, @azureProjectId, @secretName, @title,
       @purpose, @ciphertext, @iv, @tag, @keyVersion, @maskedPreview, @actor, @now, @now
     )`,
    {
      id: createId("tsec"),
      profileId,
      workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      secretName: secret.secretName,
      title: secret.title,
      purpose: secret.purpose,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      keyVersion: encrypted.keyVersion,
      maskedPreview: maskSecret(secret.value),
      actor,
      now: nowIso(),
    },
    client,
  );
}

function renameConfigKeys(config: Partial<EnvironmentConfigInput>): Partial<EnvironmentProfileView> & {
  loginPlan?: unknown;
} {
  return config as Partial<EnvironmentProfileView> & { loginPlan?: unknown };
}

function parseStoredConfig<T extends "api" | "database">(
  value: unknown,
  kind: T,
): T extends "api" ? ApiEnvironmentConfig | null : DatabaseEnvironmentConfig | null {
  if (value === null || value === undefined) return null as never;
  const schema = kind === "api" ? ApiEnvironmentConfigSchema : DatabaseEnvironmentConfigSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Environment profile has an invalid stored ${kind} configuration.`);
  }
  return parsed.data as never;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505" &&
    String((error as { constraint?: string }).constraint ?? "").includes(constraint)
  );
}

/* --------------------------------------------------------------------------
 * Login session reuse (AgentEx optimize-login, encrypted server-side).
 * One captured browser storage-state per profile; validity is proven at run
 * time against the profile's logged_in_text landmark, never assumed.
 * ------------------------------------------------------------------------ */

export const SESSION_STATE_TTL_MS = 24 * 60 * 60 * 1000;

export async function getEnvironmentSessionState(input: {
  workspaceId: string;
  environmentProfileId: string;
}): Promise<{ stateJson: string; capturedAt: string } | null> {
  const row = await sqlGet<{
    encrypted_state: string;
    encryption_iv: string;
    encryption_tag: string;
    key_version: number;
    captured_at: string;
    expires_at: string;
  }>(
    `SELECT encrypted_state, encryption_iv, encryption_tag, key_version, captured_at, expires_at
     FROM test_environment_sessions
     WHERE profile_id = @profileId AND workspace_id = @workspaceId`,
    { profileId: input.environmentProfileId, workspaceId: input.workspaceId },
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    // Expired sessions are useless credentials — remove eagerly.
    await deleteEnvironmentSession(input).catch(() => undefined);
    return null;
  }
  try {
    const stateJson = decryptSecret({
      ciphertext: row.encrypted_state,
      iv: row.encryption_iv,
      tag: row.encryption_tag,
      keyVersion: row.key_version,
    });
    await sqlRun(
      `UPDATE test_environment_sessions SET last_used_at = @now, updated_at = @now WHERE profile_id = @profileId`,
      { profileId: input.environmentProfileId, now: nowIso() },
    );
    return { stateJson, capturedAt: row.captured_at };
  } catch {
    // Undecryptable (key rotation etc.) — treat as absent.
    await deleteEnvironmentSession(input).catch(() => undefined);
    return null;
  }
}

export async function saveEnvironmentSessionState(input: {
  workspaceId: string;
  projectId: string;
  azureProjectId: string;
  environmentProfileId: string;
  stateJson: string;
}): Promise<void> {
  const encrypted = encryptSecret(input.stateJson);
  const now = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_STATE_TTL_MS).toISOString();
  await sqlRun(
    `INSERT INTO test_environment_sessions (
       id, profile_id, workspace_id, project_id, azure_project_id,
       encrypted_state, encryption_iv, encryption_tag, key_version,
       captured_at, expires_at, created_at, updated_at
     ) VALUES (
       @id, @profileId, @workspaceId, @projectId, @azureProjectId,
       @ciphertext, @iv, @tag, @keyVersion, @now, @expiresAt, @now, @now
     )
     ON CONFLICT (profile_id) DO UPDATE SET
       encrypted_state = EXCLUDED.encrypted_state,
       encryption_iv = EXCLUDED.encryption_iv,
       encryption_tag = EXCLUDED.encryption_tag,
       key_version = EXCLUDED.key_version,
       captured_at = EXCLUDED.captured_at,
       expires_at = EXCLUDED.expires_at,
       updated_at = EXCLUDED.updated_at`,
    {
      id: createId("tses"),
      profileId: input.environmentProfileId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      azureProjectId: input.azureProjectId,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      keyVersion: encrypted.keyVersion,
      now,
      expiresAt,
    },
  );
}

export async function deleteEnvironmentSession(input: {
  workspaceId: string;
  environmentProfileId: string;
}): Promise<boolean> {
  const deleted = await sqlRun(
    `DELETE FROM test_environment_sessions WHERE profile_id = @profileId AND workspace_id = @workspaceId`,
    { profileId: input.environmentProfileId, workspaceId: input.workspaceId },
  );
  return deleted > 0;
}
