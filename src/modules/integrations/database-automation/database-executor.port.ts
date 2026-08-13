import type { DatabaseEnvironmentConfig } from "@/modules/test-execution/schemas/test-execution.schemas";
import type { ExecutionBoundary } from "@/modules/test-execution/execution-boundary";
import type { TestExecutionEgressAuthorization } from "@/modules/test-execution/egress-policy.service";

export type DatabaseExecutorConfig = DatabaseEnvironmentConfig & {
  /** Derived execution boundary that authorizes the target before connecting. */
  boundary?: ExecutionBoundary;
  password: string;
  signal: AbortSignal;
  maxRows?: number;
  maxPreviewBytes?: number;
  applicationName?: string;
  /** Test/embedding seam. Production callers should provide the boundary. */
  assertTarget?: (
    target: { host: string; port: number },
  ) => Promise<TestExecutionEgressAuthorization>;
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
  /** Raw, bounded rows for in-memory capture resolution only. */
  rows: Record<string, unknown>[];
  /** Sensitive-column-redacted rows safe for prompts and persistence. */
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

export type DiscoveredDatabaseObjects = {
  objects: DiscoveredDatabaseObject[];
  /** True when the account can see more objects than the caps allow. */
  truncated: boolean;
};

/**
 * The set of objects a run may touch, derived from what the supplied database
 * account can actually see. Replaces the tester-managed schema allowlist:
 * `schemas` bounds introspection, `tables` bounds every SELECT and mutation.
 * `tables` is absent only for legacy-intent runs frozen before discovery
 * existed — those keep the schema-level authority they were approved with.
 */
export type DatabaseAccess = {
  schemas: readonly string[];
  /** Driver-canonicalized "schema.table" keys. */
  tables?: ReadonlySet<string>;
};

export interface DatabaseExecutor {
  readonly driver: "postgres" | "sqlserver" | "mysql";
  execute(request: DatabaseExecutionRequest): Promise<DatabaseExecutionResult>;
  /** Ask the account which non-system objects it can see. */
  discoverObjects(): Promise<DiscoveredDatabaseObjects>;
  /** Bound every later statement to the discovered objects. */
  setDatabaseAccess(access: DatabaseAccess): void;
  dispose(): Promise<void>;
}

export class DatabaseExecutorError extends Error {
  constructor(
    message: string,
    readonly category: "policy" | "prerequisite" | "timeout" | "transport",
    readonly uncertainSideEffect = false,
    readonly cause?: unknown,
    /** Stable machine code for the policy wall (e.g. "forbidden-sql"). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "DatabaseExecutorError";
  }
}
