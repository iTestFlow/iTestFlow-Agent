import "server-only";

import type { ApiExecutorConfig } from "@/modules/integrations/api-automation/api-executor.port";
import type { DatabaseExecutorConfig } from "@/modules/integrations/database-automation/database-executor.port";
import type { ApiConnectionSettings, DatabaseConnectionSettings, ResolvedConnection } from "./execution-connections.shared";
import { ConnectionResolutionError } from "./execution-connections.service";

type ApiConnection = ApiConnectionSettings & { credentials: Record<string, string> };
type DatabaseConnection = DatabaseConnectionSettings & { credentials: Record<string, string> };

/** One mapping for connection check and the execution worker. */
export function toApiExecutorConfig(
  connection: ApiConnection,
  signal: AbortSignal,
  authorizeTarget: ApiExecutorConfig["authorizeTarget"],
): ApiExecutorConfig {
  const auth = connection.auth.type === "apiKey"
    ? { type: "api_key" as const, location: connection.auth.in, name: connection.auth.name }
    : connection.auth.type === "oauth2ClientCredentials"
      ? { type: "oauth2_client_credentials" as const, tokenUrl: connection.auth.tokenUrl,
        clientId: connection.auth.clientId, scopes: connection.auth.scopes }
      : connection.auth;
  return {
    baseUrl: connection.baseUrl,
    auth,
    secrets: new Map(Object.entries(connection.credentials)),
    allowWrites: connection.allowWrites,
    timeoutMs: connection.timeoutMs ?? 10_000,
    signal,
    authorizeTarget,
  };
}

const DEFAULT_PORT: Record<DatabaseConnectionSettings["engine"], number> = { postgres: 5432, sqlserver: 1433, mysql: 3306 };
const SCHEME: Record<DatabaseConnectionSettings["engine"], readonly string[]> = {
  postgres: ["postgres:", "postgresql:"], sqlserver: ["sqlserver:", "mssql:"], mysql: ["mysql:"],
};

export function toDatabaseExecutorConfig(
  connection: DatabaseConnection,
  signal: AbortSignal,
  authorizeTarget: DatabaseExecutorConfig["authorizeTarget"],
): DatabaseExecutorConfig {
  let url: URL | null = null;
  if (connection.credentials.url) {
    try {
      url = new URL(connection.credentials.url);
      if (!SCHEME[connection.engine].includes(url.protocol) || !url.hostname || url.hash) throw new Error("Invalid connection URL");
    } catch {
      throw new ConnectionResolutionError(`The connection URL for "${connection.alias}" is invalid for ${connection.engine}.`);
    }
  }
  const host = connection.host ?? url?.hostname;
  const databaseName = connection.database ?? (url ? decodeURIComponent(url.pathname.replace(/^\//, "")) : undefined);
  const username = connection.username ?? (url ? decodeURIComponent(url.username) : undefined);
  const password = connection.credentials.password ?? (url ? decodeURIComponent(url.password) : undefined);
  const port = connection.port ?? (url?.port ? Number(url.port) : DEFAULT_PORT[connection.engine]);
  if (!host || !databaseName || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConnectionResolutionError(`Enter complete database connection details for "${connection.alias}".`);
  }
  const sslMode = url?.searchParams.get("sslmode");
  const tlsMode = connection.tlsMode ?? (connection.ssl === false ? "disable" : connection.ssl === true ? "verify-full"
    : sslMode === "require" ? "require" : sslMode === "disable" ? "disable" : "verify-full");
  return {
    driver: connection.engine, host, port, databaseName, username, tlsMode,
    connectTimeoutMs: 10_000, statementTimeoutMs: 30_000,
    allowWrites: connection.allowWrites, credentials: { password }, signal, authorizeTarget,
  };
}

export function asApiConnection(connection: ResolvedConnection): ApiConnection {
  if (connection.kind !== "api") throw new ConnectionResolutionError("An API connection is required.");
  return connection;
}

export function asDatabaseConnection(connection: ResolvedConnection): DatabaseConnection {
  if (connection.kind !== "database") throw new ConnectionResolutionError("A database connection is required.");
  return connection;
}
