import type { ApiAuthConfig } from "@/modules/test-execution/schemas/test-execution.schemas";
import type { TestExecutionEgressAuthorization } from "@/modules/test-execution/egress-policy.service";

export type ApiExecutorConfig = {
  /** Workspace whose allowlist authorizes every outbound API/OAuth hop. */
  workspaceId?: string;
  baseUrl: string;
  auth: ApiAuthConfig;
  connectionSecrets: ReadonlyMap<string, string>;
  requestTimeoutMs: number;
  signal: AbortSignal;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  /** Test/embedding seam. Production callers should provide workspaceId. */
  assertTarget?: (
    url: URL,
    kind: "api" | "oauth",
  ) => Promise<TestExecutionEgressAuthorization | void>;
};

export type ApiExecutionRequest = {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | null>;
  headers?: Record<string, string>;
  body?: unknown;
  contentType?: "application/json" | "text/plain" | "application/x-www-form-urlencoded";
};

export type ApiExecutionResult = {
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  safeHeaders: Record<string, string>;
  body: unknown;
  safeBody: unknown;
  contentType: string | null;
  truncated: boolean;
  durationMs: number;
  url: string;
};

export interface ApiExecutor {
  execute(request: ApiExecutionRequest): Promise<ApiExecutionResult>;
  dispose(): Promise<void>;
}

export class ApiExecutorError extends Error {
  constructor(
    message: string,
    readonly category: "policy" | "prerequisite" | "timeout" | "transport",
    readonly uncertainSideEffect = false,
    readonly cause?: unknown,
    /** Stable machine code for the policy wall (e.g. "forbidden-header"). */
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiExecutorError";
  }
}
