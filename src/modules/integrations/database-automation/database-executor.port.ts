export type DatabaseDriverName = "postgres" | "sqlserver" | "mysql";

/** Displayable connection settings. Credentials belong in the worker-only runtime field. */
export type DatabaseConnectionConfig = {
  driver: DatabaseDriverName;
  host: string;
  port: number;
  databaseName: string;
  username: string;
  tlsMode: "verify-full" | "require" | "disable";
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  allowWrites: boolean;
};

/** Never serialize this object into a run report or model prompt. */
export type DatabaseExecutorConfig = DatabaseConnectionConfig & {
  credentials: { password: string };
  signal: AbortSignal;
  maxRows?: number;
  maxPreviewBytes?: number;
  applicationName?: string;
  /** Must authorize endpoint and return concrete approved IP addresses. */
  authorizeTarget: (target: { host: string; port: number }) => Promise<{ resolvedAddresses: string[] }>;
};

export type DatabaseExecutionRequest =
  | { kind: "schema"; tablePattern?: string }
  | { kind: "select"; sql: string; parameters?: Record<string, unknown> }
  | { kind: "mutation"; sql: string; parameters?: Record<string, unknown> };

export type DatabaseExecutionResult = {
  status: "ok" | "query_error";
  command: string;
  rowCount: number;
  columns: string[];
  /** Bounded values for worker-local capture; never pass to model or reports. */
  rows: Record<string, unknown>[];
  /** Redacted values safe for model and persisted evidence. */
  safeRows: Record<string, unknown>[];
  truncated: boolean;
  durationMs: number;
  sqlState?: string;
  errorMessage?: string;
};

export type DiscoveredDatabaseObject = {
  schema: string;
  table: string;
  columns: Array<{ name: string; dataType: string }>;
};
export type DiscoveredDatabaseObjects = { objects: DiscoveredDatabaseObject[]; truncated: boolean };
export type DatabaseAccess = { schemas: readonly string[]; tables: ReadonlySet<string> };

export interface DatabaseExecutor {
  readonly driver: DatabaseDriverName;
  execute(request: DatabaseExecutionRequest): Promise<DatabaseExecutionResult>;
  discoverObjects(): Promise<DiscoveredDatabaseObjects>;
  setDatabaseAccess(access: DatabaseAccess): void;
  dispose(): Promise<void>;
}

export class DatabaseExecutorError extends Error {
  readonly cause?: unknown;
  constructor(
    message: string,
    readonly category: "policy" | "prerequisite" | "timeout" | "transport",
    readonly uncertainSideEffect = false,
    cause?: unknown,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DatabaseExecutorError";
    Object.defineProperty(this, "cause", { value: cause, enumerable: false });
  }
}
