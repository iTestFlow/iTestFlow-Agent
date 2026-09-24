import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/modules/security/encryption.service";
import {
  CONNECTION_ALIAS_PATTERN,
  MAX_EXECUTION_CONNECTIONS,
  type ConnectionInput,
  type ConnectionView,
  type ResolvedConnection,
  type ApiConnectionSettings,
  type DatabaseConnectionSettings,
} from "./execution-connections.shared";

type DbClient = Parameters<typeof sqlRun>[2];
type SavedConnectionRow = {
  alias: string;
  kind: "api" | "database";
  settings_json: Record<string, unknown>;
  credential_fields_json: string[];
  encrypted_credentials: string | null;
  credentials_iv: string | null;
  credentials_tag: string | null;
  credentials_key_version: number | null;
};

export type PreparedConnection = {
  settings: ApiConnectionSettings | DatabaseConnectionSettings;
  encryptedCredentials: EncryptedSecret | null;
  credentialFields: string[];
};

export class ConnectionResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionResolutionError";
  }
}

function encryptedFromRow(row: SavedConnectionRow): EncryptedSecret | null {
  if (!row.encrypted_credentials || !row.credentials_iv || !row.credentials_tag || row.credentials_key_version === null) return null;
  return {
    ciphertext: row.encrypted_credentials,
    iv: row.credentials_iv,
    tag: row.credentials_tag,
    keyVersion: row.credentials_key_version,
  };
}

function credentialValues(row: SavedConnectionRow): Record<string, string> {
  const encrypted = encryptedFromRow(row);
  if (!encrypted) return {};
  const value: unknown = JSON.parse(decryptSecret(encrypted));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectionResolutionError("Saved connection credentials are invalid.");
  return value as Record<string, string>;
}

async function sourceCredential(input: {
  workspaceId: string;
  projectId: string;
  fromRunId?: string;
  fromProfileId?: string;
  alias: string;
  field: string;
  target: ConnectionInput;
}): Promise<string | null> {
  const source = input.fromRunId
    ? await sqlGet<SavedConnectionRow>(
      `SELECT c.* FROM playwright_execution_run_connections c JOIN playwright_execution_runs r ON r.id = c.run_id
       WHERE c.run_id = @sourceId AND r.workspace_id = @workspaceId AND r.project_id = @projectId AND lower(c.alias) = lower(@alias)`,
      { sourceId: input.fromRunId, workspaceId: input.workspaceId, projectId: input.projectId, alias: input.alias },
    )
    : input.fromProfileId
      ? await sqlGet<SavedConnectionRow>(
        `SELECT c.* FROM playwright_execution_profile_connections c JOIN playwright_execution_profiles p ON p.id = c.profile_id
         WHERE c.profile_id = @sourceId AND p.workspace_id = @workspaceId AND p.project_id = @projectId AND lower(c.alias) = lower(@alias)`,
        { sourceId: input.fromProfileId, workspaceId: input.workspaceId, projectId: input.projectId, alias: input.alias },
      )
      : null;
  if (!source) return null;
  if (credentialBinding(source.settings_json) !== credentialBinding(input.target)) {
    throw new ConnectionResolutionError("Saved credentials require the original connection destination and authentication settings. Enter credentials again for this change.");
  }
  return credentialValues(source)[input.field] ?? null;
}

/** Saved secrets may be reused only with the same destination and auth context. */
function credentialBinding(value: Record<string, unknown> | ConnectionInput): string {
  const settings = value as Record<string, unknown>;
  if (settings.kind === "api") {
    return JSON.stringify({ kind: settings.kind, baseUrl: settings.baseUrl, auth: settings.auth });
  }
  return JSON.stringify({ kind: settings.kind, engine: settings.engine, host: settings.host, port: settings.port,
    database: settings.database, username: settings.username, ssl: settings.ssl, tlsMode: settings.tlsMode });
}

function validateSettings(connection: ConnectionInput): void {
  if (!CONNECTION_ALIAS_PATTERN.test(connection.alias)) throw new ConnectionResolutionError(`Connection alias "${connection.alias}" is invalid.`);
  if (connection.kind === "api") {
    for (const [label, value] of [["base URL", connection.baseUrl], ["OpenAPI URL", connection.openApiUrl], ["OAuth token URL", connection.auth.type === "oauth2ClientCredentials" ? connection.auth.tokenUrl : null]] as const) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid URL");
      } catch {
        throw new ConnectionResolutionError(`The ${label} for "${connection.alias}" must be an HTTP(S) URL without embedded credentials, query, or fragment.`);
      }
    }
  } else if (connection.kind === "database") {
    if (!(["postgres", "sqlserver", "mysql"] as const).includes(connection.engine)) throw new ConnectionResolutionError(`Database engine for "${connection.alias}" is invalid.`);
    if (connection.host && (connection.host.includes("/") || connection.host.includes("@"))) throw new ConnectionResolutionError(`Database host for "${connection.alias}" is invalid.`);
  } else {
    throw new ConnectionResolutionError("Connection kind is invalid.");
  }
}

export async function prepareConnections(input: {
  workspaceId: string;
  projectId: string;
  connections: readonly ConnectionInput[];
  keepSourceProfileId?: string;
}): Promise<PreparedConnection[]> {
  if (input.connections.length > MAX_EXECUTION_CONNECTIONS) throw new ConnectionResolutionError(`Use at most ${MAX_EXECUTION_CONNECTIONS} connections.`);
  const aliases = new Set<string>();
  const prepared: PreparedConnection[] = [];
  for (const connection of input.connections) {
    validateSettings(connection);
    const key = connection.alias.toLowerCase();
    if (aliases.has(key)) throw new ConnectionResolutionError(`Connection alias "${connection.alias}" is used more than once.`);
    aliases.add(key);
    const credentials: Record<string, string> = {};
    for (const [field, source] of Object.entries(connection.credentials ?? {})) {
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(field)) throw new ConnectionResolutionError(`Credential name for "${connection.alias}" is invalid.`);
      const allowed = connection.kind === "database" ? ["url", "password"] :
        connection.auth.type === "bearer" ? ["bearerToken"] :
        connection.auth.type === "basic" ? ["basicPassword"] :
        connection.auth.type === "apiKey" ? ["apiKey"] :
        connection.auth.type === "oauth2ClientCredentials" ? ["oauthClientSecret"] : [];
      if (!allowed.includes(field)) throw new ConnectionResolutionError(`Credential ${field} is not used by "${connection.alias}".`);
      let value = source.value;
      if (!value) {
        value = await sourceCredential({
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          fromRunId: source.fromRunId,
          fromProfileId: source.fromProfileId ?? (source.fromRunId ? undefined : input.keepSourceProfileId),
          alias: source.sourceAlias ?? connection.alias,
          field: source.sourceField ?? field,
          target: connection,
        }) ?? undefined;
      }
      if (!value) throw new ConnectionResolutionError(`Enter the ${field} credential for "${connection.alias}" again.`);
      credentials[field] = value;
    }
    if (connection.kind === "api") {
      const required = connection.auth.type === "bearer" ? "bearerToken" :
        connection.auth.type === "basic" ? "basicPassword" :
        connection.auth.type === "apiKey" ? "apiKey" :
        connection.auth.type === "oauth2ClientCredentials" ? "oauthClientSecret" : null;
      if (required && !credentials[required]) throw new ConnectionResolutionError(`Enter the ${required} credential for "${connection.alias}".`);
    } else if (credentials.url) {
      try {
        const url = new URL(credentials.url);
        const protocols = { postgres: ["postgres:", "postgresql:"], sqlserver: ["sqlserver:", "mssql:"], mysql: ["mysql:"] }[connection.engine];
        if (!protocols.includes(url.protocol) || !(connection.host || url.hostname) ||
          !(connection.database || url.pathname.replace(/^\//, "")) || !(connection.username || url.username) ||
          !(credentials.password || url.password) || url.hash) throw new Error("Invalid database URL");
      } catch {
        throw new ConnectionResolutionError(`The connection URL for "${connection.alias}" is incomplete or invalid.`);
      }
    } else if (!connection.host || !connection.database || !connection.username || !credentials.password) {
      throw new ConnectionResolutionError(`Enter complete database connection details for "${connection.alias}".`);
    }
    const { credentials: _discard, ...settings } = connection;
    prepared.push({
      settings: settings as ApiConnectionSettings | DatabaseConnectionSettings,
      encryptedCredentials: Object.keys(credentials).length ? encryptSecret(JSON.stringify(credentials)) : null,
      credentialFields: Object.keys(credentials),
    });
  }
  return prepared;
}

function viewConnection(row: SavedConnectionRow): ConnectionView {
  const settings = row.settings_json as unknown as Omit<ConnectionView, "savedCredentials">;
  return { ...settings, savedCredentials: Object.fromEntries((row.credential_fields_json ?? []).map((field) => [field, true])) } as ConnectionView;
}

export async function listProfileConnections(profileId: string): Promise<ConnectionView[]> {
  const rows = await sqlAll<SavedConnectionRow>(
    `SELECT alias, kind, settings_json, credential_fields_json, encrypted_credentials, credentials_iv, credentials_tag, credentials_key_version
       FROM playwright_execution_profile_connections WHERE profile_id = @profileId ORDER BY position`, { profileId },
  );
  return rows.map(viewConnection);
}

export async function listRunConnections(runId: string): Promise<ConnectionView[]> {
  const rows = await sqlAll<SavedConnectionRow>(
    `SELECT alias, kind, settings_json, credential_fields_json, encrypted_credentials, credentials_iv, credentials_tag, credentials_key_version
       FROM playwright_execution_run_connections WHERE run_id = @runId ORDER BY position`, { runId },
  );
  return rows.map(viewConnection);
}

/** Worker only. Credentials never enter route responses or model context. */
export async function resolveRunConnections(runId: string): Promise<ResolvedConnection[]> {
  const rows = await sqlAll<SavedConnectionRow>(
    `SELECT alias, kind, settings_json, credential_fields_json, encrypted_credentials, credentials_iv, credentials_tag, credentials_key_version
       FROM playwright_execution_run_connections WHERE run_id = @runId ORDER BY position`, { runId },
  );
  return rows.map((row) => ({ ...row.settings_json, credentials: credentialValues(row) } as ResolvedConnection));
}

async function insertConnection(client: DbClient, owner: "profile" | "run", ownerId: string, entry: PreparedConnection, position: number, now: string): Promise<void> {
  const encrypted = entry.encryptedCredentials;
  const table = owner === "profile" ? "playwright_execution_profile_connections" : "playwright_execution_run_connections";
  const ownerColumn = owner === "profile" ? "profile_id" : "run_id";
  await sqlRun(
    `INSERT INTO ${table} (id, ${ownerColumn}, position, alias, kind, settings_json, credential_fields_json,
      encrypted_credentials, credentials_iv, credentials_tag, credentials_key_version, created_at${owner === "profile" ? ", updated_at" : ""})
     VALUES (@id, @ownerId, @position, @alias, @kind, @settings::jsonb, @fields::jsonb,
      @encrypted, @iv, @tag, @version, @now${owner === "profile" ? ", @now" : ""})`,
    { id: createId("pwconn"), ownerId, position, alias: entry.settings.alias, kind: entry.settings.kind,
      settings: JSON.stringify(entry.settings), fields: JSON.stringify(entry.credentialFields),
      encrypted: encrypted?.ciphertext ?? null, iv: encrypted?.iv ?? null, tag: encrypted?.tag ?? null,
      version: encrypted?.keyVersion ?? null, now }, client,
  );
}

export async function insertProfileConnections(client: DbClient, profileId: string, entries: readonly PreparedConnection[], now = nowIso()): Promise<void> {
  for (const [position, entry] of entries.entries()) await insertConnection(client, "profile", profileId, entry, position, now);
}

export async function insertRunConnections(client: DbClient, runId: string, entries: readonly PreparedConnection[], now = nowIso()): Promise<void> {
  for (const [position, entry] of entries.entries()) await insertConnection(client, "run", runId, entry, position, now);
}
