import type { DatabaseEnvironmentConfig } from "@/modules/test-execution/schemas/test-execution.schemas";
import type { TestExecutionEgressAuthorization } from "@/modules/test-execution/egress-policy.service";

export type DatabaseExecutorConfig = DatabaseEnvironmentConfig & {
  /** Workspace whose allowlist authorizes the target before connecting. */
  workspaceId?: string;
  password: string;
  signal: AbortSignal;
  maxRows?: number;
  maxPreviewBytes?: number;
  applicationName?: string;
  /** Test/embedding seam. Production callers should provide workspaceId. */
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

export interface DatabaseExecutor {
  readonly driver: "postgres" | "sqlserver" | "mysql";
  execute(request: DatabaseExecutionRequest): Promise<DatabaseExecutionResult>;
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
