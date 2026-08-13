import "server-only";

import type { ApiAuthConfig } from "@/modules/test-execution/schemas/test-execution.schemas";
import { assertBoundaryEgressAllowed } from "@/modules/test-execution/egress-policy.service";
import { isForbiddenRequestHeader, isSensitiveKey } from "@/modules/shared/sensitive-data";

import {
  ApiExecutorError,
  type ApiExecutionRequest,
  type ApiExecutionResult,
  type ApiExecutor,
  type ApiExecutorConfig,
} from "./api-executor.port";
import { requestPinnedHttp, type PinnedHttpRequest } from "./pinned-http-transport";

const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_REDIRECTS = 5;

type FetchLike = typeof fetch;
type ApiHop =
  | { kind: "redirect"; statusCode: number; location: string | null }
  | {
      kind: "response";
      statusCode: number;
      statusText: string;
      headers: Record<string, string>;
      safeHeaders: Record<string, string>;
      body: unknown;
      safeBody: unknown;
      contentType: string | null;
      truncated: boolean;
    };

export class GuardedApiExecutor implements ApiExecutor {
  private readonly baseUrl: URL;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private oauthToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: ApiExecutorConfig,
    /** Test-only transport seam. Production requests use requestPinnedHttp. */
    private readonly fetchImpl?: FetchLike,
    private readonly pinnedRequest: PinnedHttpRequest = requestPinnedHttp,
  ) {
    this.baseUrl = normalizedBaseUrl(config.baseUrl);
    this.maxRequestBytes = config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  }

  async execute(request: ApiExecutionRequest): Promise<ApiExecutionResult> {
    const started = Date.now();
    const target = this.resolveTarget(request.path, request.query);
    const headers = await this.buildHeaders(request);
    this.applyQueryAuthentication(target);
    const body = serializeBody(request.body, request.contentType, headers);
    if (body && Buffer.byteLength(body) > this.maxRequestBytes) {
      throw new ApiExecutorError(`API request body exceeds ${this.maxRequestBytes} bytes.`, "policy");
    }

    let current = target;
    const mutation = isMutationMethod(request.method);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      const hop = await this.fetchWithTimeout<ApiHop>(
        current,
        {
          method: request.method,
          headers,
          body: mutation ? body : undefined,
          redirect: "manual",
        },
        mutation,
        "api",
        async (response, signal) => {
          if (isRedirectStatus(response.status)) {
            // Do not keep an unread redirect body/socket alive while deciding
            // whether the next hop is authorized.
            void response.body?.cancel().catch(() => undefined);
            return {
              kind: "redirect",
              statusCode: response.status,
              location: response.headers.get("location"),
            };
          }

          const bounded = await readBoundedBody(response, this.maxResponseBytes, signal);
          const contentType = response.headers.get("content-type");
          const parsedBody = parseResponseBody(bounded.bytes, contentType);
          const responseHeaders = Object.fromEntries(response.headers.entries());
          const safeHeaders = redactHeaders(responseHeaders);
          return {
            kind: "response",
            statusCode: response.status,
            statusText: response.statusText,
            headers: safeHeaders,
            safeHeaders,
            body: parsedBody,
            safeBody: redactSensitiveData(parsedBody),
            contentType,
            truncated: bounded.truncated,
          };
        },
      );
      if (hop.kind === "redirect") {
        if (mutation) {
          throw new ApiExecutorError(
            `API mutation returned HTTP ${hop.statusCode}; redirects are not followed for state-changing requests and the outcome must be verified.`,
            "transport",
            true,
          );
        }
        if (!hop.location) throw new ApiExecutorError("API redirect did not include a Location header.", "transport");
        if (redirect === MAX_REDIRECTS) throw new ApiExecutorError("API redirect limit exceeded.", "policy");
        let redirected: URL;
        try {
          redirected = new URL(hop.location, current);
        } catch (error) {
          throw new ApiExecutorError("API redirect Location is invalid.", "policy", false, error);
        }
        if (!this.isWithinBase(redirected)) {
          throw new ApiExecutorError("API redirects may not leave the configured base URL.", "policy");
        }
        this.applyQueryAuthentication(redirected);
        current = redirected;
        continue;
      }

      return {
        statusCode: hop.statusCode,
        statusText: hop.statusText,
        headers: hop.headers,
        safeHeaders: hop.safeHeaders,
        body: hop.body,
        safeBody: hop.safeBody,
        contentType: hop.contentType,
        truncated: hop.truncated,
        durationMs: Date.now() - started,
        url: safeUrlForEvidence(current, this.config.auth),
      };
    }
    throw new ApiExecutorError("API redirect handling failed.", "transport");
  }

  async dispose(): Promise<void> {
    this.oauthToken = null;
  }

  private resolveTarget(path: string, query?: ApiExecutionRequest["query"]) {
    if (path.startsWith("//")) throw new ApiExecutorError("Protocol-relative API paths are forbidden.", "policy", false, undefined, "path-invalid");
    // WHATWG URL treats backslashes like slashes in special URLs, so "\\evil"
    // would parse protocol-relative. Reject them before parsing.
    if (path.includes("\\")) throw new ApiExecutorError("API paths may not contain backslashes.", "policy", false, undefined, "path-invalid");
    let target: URL;
    try {
      // API/OpenAPI operation paths conventionally start with '/', while a
      // configured base URL may include a prefix. Resolve `/orders` beneath
      // `/api/v1/`, and accept an already-prefixed `/api/v1/orders` — but a
      // path that collides with the base prefix at a NON-segment boundary
      // (`/api/v10/...` against `/api/v1/`) is rejected instead of being
      // silently re-rooted to a different endpoint.
      const basePath = this.baseUrl.pathname; // normalized with trailing "/"
      const alreadyPrefixed = path.startsWith(basePath) || `${path}/` === basePath;
      if (path.startsWith("/") && basePath !== "/" && !alreadyPrefixed && path.startsWith(basePath.slice(0, -1))) {
        throw new ApiExecutorError("API path is outside the configured base URL.", "policy", false, undefined, "path-out-of-base");
      }
      const relativeToPrefix =
        path.startsWith("/") && basePath !== "/" && !alreadyPrefixed
          ? path.slice(1)
          : path;
      target = new URL(relativeToPrefix, this.baseUrl);
    } catch (error) {
      if (error instanceof ApiExecutorError) throw error;
      throw new ApiExecutorError("API path is invalid.", "policy", false, error, "path-invalid");
    }
    if (!this.isWithinBase(target)) {
      throw new ApiExecutorError("API path escapes the configured base URL.", "policy", false, undefined, "path-out-of-base");
    }
    // new URL() normalizes literal "../"; only percent-encoded traversal can
    // survive into pathname, where a backend may decode it. Canonicalize and
    // reject rather than forward.
    if (hasEncodedTraversalSegment(target.pathname)) {
      throw new ApiExecutorError("API path contains a traversal segment.", "policy", false, undefined, "path-traversal");
    }
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== null) target.searchParams.set(name, String(value));
    }
    return target;
  }

  private isWithinBase(target: URL) {
    return (
      target.origin === this.baseUrl.origin &&
      (target.pathname.startsWith(this.baseUrl.pathname) || `${target.pathname}/` === this.baseUrl.pathname) &&
      target.username.length === 0 &&
      target.password.length === 0
    );
  }

  private applyQueryAuthentication(target: URL) {
    if (this.config.auth.type === "api_key" && this.config.auth.location === "query") {
      target.searchParams.set(
        this.config.auth.name,
        requiredSecret(this.config.connectionSecrets, "api.api_key"),
      );
    }
  }

  private async buildHeaders(request: ApiExecutionRequest) {
    const headers = new Headers({ Accept: "application/json, text/plain;q=0.9, */*;q=0.5" });
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (isForbiddenRequestHeader(name)) {
        throw new ApiExecutorError(`Request header "${name}" is forbidden.`, "policy", false, undefined, "forbidden-header");
      }
      headers.set(name, value);
    }
    await applyAuth(headers, this.config.auth, this.config.connectionSecrets, async () => this.getOAuthToken());
    return headers;
  }

  private async getOAuthToken() {
    if (this.oauthToken && this.oauthToken.expiresAt > Date.now() + 10_000) return this.oauthToken.value;
    const auth = this.config.auth;
    if (auth.type !== "oauth2_client_credentials") throw new ApiExecutorError("OAuth is not configured.", "prerequisite");
    const secret = requiredSecret(this.config.connectionSecrets, "api.oauth_client_secret");
    const target = new URL(auth.tokenUrl);
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: auth.clientId, client_secret: secret });
    if (auth.scopes.length) form.set("scope", auth.scopes.join(" "));
    if (auth.audience) form.set("audience", auth.audience);
    const payload = await this.fetchWithTimeout(
      target,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "manual",
      },
      false,
      "oauth",
      async (response, signal) => {
        const bounded = await readBoundedBody(response, MAX_OAUTH_RESPONSE_BYTES, signal);
        if (bounded.truncated) {
          throw new ApiExecutorError("OAuth token response exceeded the allowed size.", "prerequisite");
        }
        if (!response.ok) {
          throw new ApiExecutorError(`OAuth token endpoint returned HTTP ${response.status}.`, "prerequisite");
        }
        try {
          return JSON.parse(new TextDecoder().decode(bounded.bytes)) as {
            access_token?: unknown;
            expires_in?: unknown;
          };
        } catch (error) {
          throw new ApiExecutorError("OAuth token response was not valid JSON.", "prerequisite", false, error);
        }
      },
    );
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new ApiExecutorError("OAuth token response did not contain access_token.", "prerequisite");
    }
    const expiresIn = typeof payload.expires_in === "number" ? Math.max(30, payload.expires_in) : 300;
    this.oauthToken = { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1_000 };
    return payload.access_token;
  }

  private async fetchWithTimeout<T>(
    url: URL,
    init: RequestInit,
    uncertainSideEffect: boolean,
    targetKind: "api" | "oauth",
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.config.signal.aborted) throw new ApiExecutorError("API execution was canceled.", "transport", uncertainSideEffect);
    // Resolve DNS and authorize again for every network hop. Keeping this next
    // to fetch narrows the DNS-rebinding window and covers redirected targets.
    const authorization = await this.assertTarget(url, targetKind);
    if (this.config.signal.aborted) throw new ApiExecutorError("API execution was canceled.", "transport", uncertainSideEffect);
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.config.signal.reason);
    this.config.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("timeout"));
    }, this.config.requestTimeoutMs);
    try {
      const requestInit = { ...init, signal: controller.signal };
      const response = this.fetchImpl
        ? await this.fetchImpl(url, requestInit)
        : await this.pinnedRequest(
            url,
            requestInit,
            requiredAuthorizedAddress(authorization),
          );
      return await consume(response, controller.signal);
    } catch (error) {
      if (error instanceof ApiExecutorError) throw error;
      throw new ApiExecutorError(
        timedOut ? `API request timed out after ${this.config.requestTimeoutMs} ms.` : "API transport failed.",
        timedOut ? "timeout" : "transport",
        uncertainSideEffect,
        error,
      );
    } finally {
      clearTimeout(timer);
      this.config.signal.removeEventListener("abort", onAbort);
    }
  }

  private async assertTarget(url: URL, kind: "api" | "oauth") {
    try {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS egress is supported.");
      }
      if (this.config.boundary) {
        return await assertBoundaryEgressAllowed(this.config.boundary, {
          targetKind: kind,
          protocol: url.protocol === "https:" ? "https" : "http",
          host: url.hostname,
          port: effectivePort(url),
        });
      }
      if (this.config.assertTarget) {
        return await this.config.assertTarget(url, kind);
      }
      throw new Error("Execution boundary is not configured.");
    } catch (error) {
      throw new ApiExecutorError(
        `${kind === "oauth" ? "OAuth" : "API"} target is denied by the test-execution network policy.`,
        "policy",
        false,
        error,
      );
    }
  }
}

function requiredAuthorizedAddress(
  authorization: Awaited<ReturnType<typeof assertBoundaryEgressAllowed>> | void,
): string {
  const address = authorization?.resolvedAddresses[0];
  if (!address) {
    throw new ApiExecutorError(
      "The egress policy did not provide a concrete authorized address.",
      "policy",
    );
  }
  return address;
}

async function applyAuth(
  headers: Headers,
  auth: ApiAuthConfig,
  secrets: ReadonlyMap<string, string>,
  oauth: () => Promise<string>,
) {
  switch (auth.type) {
    case "none": return;
    case "bearer": headers.set("Authorization", `Bearer ${requiredSecret(secrets, "api.bearer_token")}`); return;
    case "api_key": {
      const value = requiredSecret(secrets, "api.api_key");
      if (auth.location === "header") headers.set(auth.name, value);
      // Query API keys are applied directly to the request URL after validation.
      return;
    }
    case "basic": {
      const password = requiredSecret(secrets, "api.basic_password");
      headers.set("Authorization", `Basic ${Buffer.from(`${auth.username}:${password}`).toString("base64")}`);
      return;
    }
    case "oauth2_client_credentials": headers.set("Authorization", `Bearer ${await oauth()}`); return;
  }
}

function requiredSecret(secrets: ReadonlyMap<string, string>, name: string) {
  const value = secrets.get(name);
  if (!value) throw new ApiExecutorError(`Required API credential ${name} is not configured.`, "prerequisite");
  return value;
}

function serializeBody(body: unknown, contentType: ApiExecutionRequest["contentType"], headers: Headers): string | undefined {
  if (body === undefined) return undefined;
  const kind = contentType ?? (typeof body === "string" ? "text/plain" : "application/json");
  headers.set("Content-Type", kind);
  if (kind === "application/json") return JSON.stringify(body);
  if (kind === "application/x-www-form-urlencoded") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiExecutorError("Form body must be an object.", "policy");
    return new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, String(value)])).toString();
  }
  return String(body);
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal) {
  throwIfAborted(signal);
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const part = await reader.read();
      throwIfAborted(signal);
      if (part.done) break;
      if (size + part.value.byteLength > maxBytes) {
        const remaining = Math.max(0, maxBytes - size);
        if (remaining) chunks.push(part.value.slice(0, remaining));
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(part.value);
      size += part.value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new Error("API execution was canceled.");
}

function parseResponseBody(bytes: Uint8Array, contentType: string | null): unknown {
  const text = new TextDecoder().decode(bytes);
  if (!text) return null;
  if (contentType?.toLowerCase().includes("json")) {
    try { return JSON.parse(text); } catch { return { invalidJsonPreview: text }; }
  }
  if (contentType?.startsWith("text/") || !contentType) return text;
  return { binary: true, byteLength: bytes.byteLength, contentType };
}

export function redactSensitiveData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    isSensitiveKey(key) ? "[REDACTED]" : redactSensitiveData(entry),
  ]));
}

function redactHeaders(headers: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, isSensitiveKey(key) ? "[REDACTED]" : value]));
}

function normalizedBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiExecutorError("API base URL must use HTTP or HTTPS.", "policy");
  }
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  url.search = "";
  url.hash = "";
  return url;
}

function effectivePort(url: URL) {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function safeUrlForEvidence(url: URL, auth: ApiAuthConfig) {
  const copy = new URL(url);
  if (auth.type === "api_key" && auth.location === "query") copy.searchParams.set(auth.name, "[REDACTED]");
  return copy.toString();
}

function isRedirectStatus(status: number) { return [301, 302, 303, 307, 308].includes(status); }
function isMutationMethod(method: string) { return !["GET", "HEAD"].includes(method.toUpperCase()); }

/** True when a decoded path segment is "." / ".." or smuggles a separator. */
function hasEncodedTraversalSegment(pathname: string): boolean {
  for (const segment of pathname.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true; // Malformed encoding never reaches the backend.
    }
    if (decoded === "." || decoded === "..") return true;
    if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..")) return true;
  }
  return false;
}
