/** Public connection settings. Credentials are write-only and never appear in views. */
export type ConnectionSecretInput = {
  value?: string;
  fromRunId?: string;
  fromProfileId?: string;
  sourceAlias?: string;
  sourceField?: string;
};

export type ApiAuthentication =
  | { type: "none" }
  | { type: "bearer" }
  | { type: "basic"; username: string }
  | { type: "apiKey"; name: string; in: "header" | "query" }
  | { type: "oauth2ClientCredentials"; tokenUrl: string; clientId: string; scopes?: string[] };

export type ApiConnectionSettings = {
  kind: "api";
  alias: string;
  baseUrl: string;
  auth: ApiAuthentication;
  openApiUrl?: string | null;
  timeoutMs?: number;
  allowWrites: boolean;
};

export type DatabaseConnectionSettings = {
  kind: "database";
  alias: string;
  engine: "postgres" | "sqlserver" | "mysql";
  host?: string;
  port?: number;
  database?: string;
  username?: string;
  ssl?: boolean;
  tlsMode?: "verify-full" | "require" | "disable";
  allowWrites: boolean;
};

/** `url` or `password` for DB; `bearerToken`, `basicPassword`, `apiKey`, or `oauthClientSecret` for API. */
export type ConnectionInput = (ApiConnectionSettings | DatabaseConnectionSettings) & {
  credentials?: Record<string, ConnectionSecretInput>;
};

export type ConnectionView = (ApiConnectionSettings | DatabaseConnectionSettings) & {
  savedCredentials: Record<string, boolean>;
};

export type ResolvedConnection = (ApiConnectionSettings | DatabaseConnectionSettings) & {
  credentials: Record<string, string>;
};

export type StepPhase = "setup" | "scenario" | "cleanup";

export const MAX_EXECUTION_CONNECTIONS = 20;
export const CONNECTION_ALIAS_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
