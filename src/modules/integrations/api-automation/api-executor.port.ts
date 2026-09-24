export type ApiAuthConfig =
  | { type: "none" }
  | { type: "bearer" }
  | { type: "api_key"; location: "header" | "query"; name: string }
  | { type: "basic"; username: string }
  | { type: "oauth2_client_credentials"; tokenUrl: string; clientId: string; scopes?: string[]; audience?: string };

export type ApiExecutorConfig = {
  baseUrl: string;
  auth: ApiAuthConfig;
  /** Secrets stay in worker memory; map keys: bearerToken, apiKey, basicPassword, oauthClientSecret. */
  secrets: ReadonlyMap<string, string>;
  allowWrites: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  /** Must check exact host and port against immutable run policy, resolve DNS, and reject disallowed IPs. */
  authorizeTarget: (url: URL, kind: "api" | "oauth") => Promise<{ resolvedAddresses: string[] }>;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
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
  body: unknown;
  /** Worker-only source for explicit case captures. Non-enumerable; never serialize or send to a model. */
  readonly rawBody?: unknown;
  contentType: string | null;
  truncated: boolean;
  durationMs: number;
  url: string;
};

export class ApiExecutorError extends Error {
  constructor(
    message: string,
    readonly category: "policy" | "prerequisite" | "timeout" | "transport",
    readonly uncertainSideEffect = false,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiExecutorError";
  }
}
