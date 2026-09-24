import { isIP } from "node:net";

import { ApiExecutorError, type ApiAuthConfig, type ApiExecutionRequest, type ApiExecutionResult, type ApiExecutorConfig } from "./api-executor.port";
import { requestPinnedHttp, type PinnedHttpResponse } from "./pinned-http-transport";

export { ApiExecutorError } from "./api-executor.port";
export type { ApiAuthConfig, ApiExecutionRequest, ApiExecutionResult, ApiExecutorConfig } from "./api-executor.port";

const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 2 * 1024 * 1024;
const OAUTH_LIMIT = 64 * 1024;
const REDIRECT_LIMIT = 5;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const SAFE_HEADERS = new Set(["content-type", "content-length", "cache-control", "etag", "last-modified"]);
const SENSITIVE_KEY = /(^|[_-])(secret|token|password|credential|authorization|cookie|api[_-]?key)([_-]|$)/i;

export class GuardedApiExecutor {
  private readonly baseUrl: URL;
  private readonly requestLimit: number;
  private readonly responseLimit: number;
  private oauthToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ApiExecutorConfig) {
    this.baseUrl = parseHttpUrl(config.baseUrl, "API base URL");
    if (this.baseUrl.search || this.baseUrl.hash || this.baseUrl.username || this.baseUrl.password) throw new ApiExecutorError("API base URL cannot include credentials, query, or fragment.", "policy");
    if (!this.baseUrl.pathname.endsWith("/")) this.baseUrl.pathname += "/";
    if (typeof config.authorizeTarget !== "function") throw new ApiExecutorError("API network policy is missing.", "policy");
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) throw new ApiExecutorError("API timeout is invalid.", "policy");
    this.requestLimit = byteLimit(config.maxRequestBytes, REQUEST_LIMIT);
    this.responseLimit = byteLimit(config.maxResponseBytes, RESPONSE_LIMIT);
  }

  async execute(request: ApiExecutionRequest): Promise<ApiExecutionResult> {
    if (!METHODS.has(request.method)) throw new ApiExecutorError("API method is unsupported.", "policy");
    const mutation = request.method !== "GET" && request.method !== "HEAD";
    if (mutation && !this.config.allowWrites) throw new ApiExecutorError("API writes are disabled for this connection.", "policy", false, "write-disabled");
    if (!mutation && request.body !== undefined) throw new ApiExecutorError("GET and HEAD cannot have a body.", "policy");
    const started = Date.now();
    const target = this.resolveTarget(request.path, request.query);
    const headers = await this.buildHeaders(request.headers);
    this.applyQueryAuth(target);
    const body = serializeBody(request.body, request.contentType, headers);
    if (body !== undefined && Buffer.byteLength(body) > this.requestLimit) throw new ApiExecutorError("API request body exceeds byte limit.", "policy");

    let current = target;
    for (let redirects = 0; redirects <= REDIRECT_LIMIT; redirects += 1) {
      const response = await this.send(current, request.method, headers, body, this.responseLimit, "api", mutation);
      if (isRedirect(response.statusCode)) {
        if (mutation) throw new ApiExecutorError("API write returned a redirect; verify remote outcome.", "transport", true, "uncertain-write");
        if (redirects === REDIRECT_LIMIT) throw new ApiExecutorError("API redirect limit exceeded.", "policy");
        if (!response.headers.location) throw new ApiExecutorError("API redirect has no Location header.", "transport");
        let next: URL;
        try { next = new URL(response.headers.location, current); } catch { throw new ApiExecutorError("API redirect URL is invalid.", "policy"); }
        this.assertWithinBase(next);
        assertSafePath(next.pathname);
        this.applyQueryAuth(next);
        current = next;
        continue;
      }
      const contentType = response.headers["content-type"] ?? null;
      const rawBody = parseBody(response.bytes, contentType);
      const result: ApiExecutionResult = {
        statusCode: response.statusCode,
        statusText: this.redact(response.statusText),
        headers: Object.fromEntries(Object.entries(response.headers).filter(([name]) => SAFE_HEADERS.has(name)).map(([name, value]) => [name, this.redact(value)])),
        body: this.redactValue(rawBody),
        contentType: contentType ? this.redact(contentType) : null,
        truncated: response.truncated,
        durationMs: Date.now() - started,
        url: this.redactUrl(current),
      };
      Object.defineProperty(result, "rawBody", { value: rawBody, enumerable: false });
      return result;
    }
    throw new ApiExecutorError("API redirect handling failed.", "transport");
  }

  async dispose(): Promise<void> { this.oauthToken = null; }

  private resolveTarget(path: string, query?: ApiExecutionRequest["query"]): URL {
    if (typeof path !== "string" || path.startsWith("//") || path.includes("\\") || /^[a-z][a-z\d+.-]*:/i.test(path)) throw new ApiExecutorError("API path is invalid.", "policy", false, "path-invalid");
    assertSafePath(path.split("?")[0]);
    const prefix = this.baseUrl.pathname;
    const alreadyPrefixed = path.startsWith(prefix) || `${path}/` === prefix;
    if (path.startsWith("/") && prefix !== "/" && !alreadyPrefixed && path.startsWith(prefix.slice(0, -1))) throw new ApiExecutorError("API path is outside base URL.", "policy", false, "path-out-of-base");
    const relative = path.startsWith("/") && prefix !== "/" && !alreadyPrefixed ? path.slice(1) : path;
    let url: URL;
    try { url = new URL(relative, this.baseUrl); } catch { throw new ApiExecutorError("API path is invalid.", "policy", false, "path-invalid"); }
    this.assertWithinBase(url);
    assertSafePath(url.pathname);
    for (const [name, value] of Object.entries(query ?? {})) if (value !== null) url.searchParams.set(name, String(value));
    return url;
  }

  private assertWithinBase(url: URL) {
    if (url.origin !== this.baseUrl.origin || !(url.pathname.startsWith(this.baseUrl.pathname) || `${url.pathname}/` === this.baseUrl.pathname) || url.username || url.password) throw new ApiExecutorError("API target leaves base URL.", "policy", false, "path-out-of-base");
  }

  private async buildHeaders(requestHeaders?: Record<string, string>) {
    const headers = new Headers({ Accept: "application/json, text/plain;q=0.9, */*;q=0.5" });
    for (const [name, value] of Object.entries(requestHeaders ?? {})) {
      if (forbiddenHeader(name)) throw new ApiExecutorError(`API request header ${name} is forbidden.`, "policy", false, "forbidden-header");
      try { headers.set(name, value); } catch { throw new ApiExecutorError("API request header is invalid.", "policy", false, "forbidden-header"); }
    }
    const auth = this.config.auth;
    switch (auth.type) {
      case "none": break;
      case "bearer": headers.set("Authorization", `Bearer ${this.secret("bearerToken")}`); break;
      case "basic": headers.set("Authorization", `Basic ${Buffer.from(`${auth.username}:${this.secret("basicPassword")}`).toString("base64")}`); break;
      case "api_key":
        assertAuthName(auth.name);
        if (auth.location === "header") {
          if (forbiddenHeader(auth.name)) throw new ApiExecutorError("API key header is forbidden.", "policy");
          headers.set(auth.name, this.secret("apiKey"));
        }
        break;
      case "oauth2_client_credentials": headers.set("Authorization", `Bearer ${await this.getOAuthToken()}`); break;
    }
    return headers;
  }

  private applyQueryAuth(url: URL) {
    const auth = this.config.auth;
    if (auth.type === "api_key" && auth.location === "query") { assertAuthName(auth.name); url.searchParams.set(auth.name, this.secret("apiKey")); }
  }

  private secret(name: string) {
    const value = this.config.secrets.get(name);
    if (!value) throw new ApiExecutorError(`Required API credential ${name} is missing.`, "prerequisite");
    return value;
  }

  private async getOAuthToken() {
    if (this.oauthToken && this.oauthToken.expiresAt > Date.now() + 10_000) return this.oauthToken.value;
    const auth = this.config.auth;
    if (auth.type !== "oauth2_client_credentials") throw new ApiExecutorError("OAuth is not configured.", "prerequisite");
    const tokenUrl = parseHttpUrl(auth.tokenUrl, "OAuth token URL");
    if (tokenUrl.username || tokenUrl.password || tokenUrl.hash) throw new ApiExecutorError("OAuth token URL is invalid.", "policy");
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: auth.clientId, client_secret: this.secret("oauthClientSecret") });
    if (auth.scopes?.length) form.set("scope", auth.scopes.join(" "));
    if (auth.audience) form.set("audience", auth.audience);
    const response = await this.send(tokenUrl, "POST", new Headers({ Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }), form.toString(), OAUTH_LIMIT, "oauth", false);
    if (isRedirect(response.statusCode) || response.statusCode < 200 || response.statusCode >= 300 || response.truncated) throw new ApiExecutorError(`OAuth token endpoint returned HTTP ${response.statusCode}.`, "prerequisite");
    let parsed: unknown;
    try { parsed = JSON.parse(response.bytes.toString("utf8")); } catch { throw new ApiExecutorError("OAuth token response is not valid JSON.", "prerequisite"); }
    if (!parsed || typeof parsed !== "object" || typeof (parsed as { access_token?: unknown }).access_token !== "string" || !(parsed as { access_token: string }).access_token) throw new ApiExecutorError("OAuth token response has no access_token.", "prerequisite");
    const payload = parsed as { access_token: string; expires_in?: unknown };
    const seconds = typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in) ? Math.max(1, payload.expires_in) : 300;
    this.oauthToken = { value: payload.access_token, expiresAt: Date.now() + seconds * 1000 };
    return payload.access_token;
  }

  private async send(url: URL, method: string, headers: Headers, body: string | undefined, maxResponseBytes: number, kind: "api" | "oauth", mutation: boolean): Promise<PinnedHttpResponse> {
    if (this.config.signal.aborted) throw new ApiExecutorError("API execution canceled.", "transport");
    let address: string;
    let authorizationTimer: ReturnType<typeof setTimeout> | undefined;
    let onAuthorizationAbort: (() => void) | undefined;
    try {
      const authorization = await Promise.race([
        this.config.authorizeTarget(url, kind),
        new Promise<never>((_resolve, reject) => {
          authorizationTimer = setTimeout(() => reject(new ApiExecutorError("API target authorization timed out.", "timeout")), this.config.timeoutMs);
          onAuthorizationAbort = () => reject(new ApiExecutorError("API execution canceled.", "transport"));
          this.config.signal.addEventListener("abort", onAuthorizationAbort, { once: true });
        }),
      ]);
      address = authorization.resolvedAddresses[0];
      if (!address || isIP(address) === 0) throw new Error("No authorized address");
    } catch (error) {
      if (error instanceof ApiExecutorError) throw error;
      throw new ApiExecutorError(`${kind === "oauth" ? "OAuth" : "API"} target denied by network policy.`, "policy", false, "egress-denied");
    } finally {
      if (authorizationTimer) clearTimeout(authorizationTimer);
      if (onAuthorizationAbort) this.config.signal.removeEventListener("abort", onAuthorizationAbort);
    }
    if (this.config.signal.aborted) throw new ApiExecutorError("API execution canceled.", "transport");
    const controller = new AbortController();
    const onAbort = () => controller.abort(this.config.signal.reason);
    this.config.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("deadline exceeded")), this.config.timeoutMs);
    try { return await requestPinnedHttp({ url, address, method, headers, body, maxResponseBytes, signal: controller.signal }); }
    catch {
      const timeout = controller.signal.aborted && !this.config.signal.aborted;
      throw new ApiExecutorError(timeout ? "API request timed out." : "API transport failed.", timeout ? "timeout" : "transport", mutation, mutation ? "uncertain-write" : undefined);
    } finally { clearTimeout(timer); this.config.signal.removeEventListener("abort", onAbort); }
  }

  private redact(value: string) {
    let result = value;
    for (const secret of this.config.secrets.values()) {
      if (!secret) continue;
      for (const form of [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6)]) {
        result = result.split(form).join("[REDACTED]");
      }
    }
    const auth = this.config.auth;
    if (auth.type === "basic") {
      const password = this.config.secrets.get("basicPassword");
      if (password) result = result.split(Buffer.from(`${auth.username}:${password}`).toString("base64")).join("[REDACTED]");
    }
    if (this.oauthToken?.value) result = result.split(this.oauthToken.value).join("[REDACTED]");
    return result;
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === "string") return this.redact(value);
    if (Array.isArray(value)) return value.map((entry) => this.redactValue(entry));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : this.redactValue(entry)]));
    return value;
  }

  private redactUrl(url: URL) {
    const safe = new URL(url);
    const auth = this.config.auth;
    if (auth.type === "api_key" && auth.location === "query") safe.searchParams.set(auth.name, "[REDACTED]");
    return this.redact(safe.toString());
  }
}

function parseHttpUrl(value: string, label: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiExecutorError(`${label} is invalid.`, "policy"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ApiExecutorError(`${label} must use HTTP or HTTPS.`, "policy");
  return url;
}

function byteLimit(value: number | undefined, fallback: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > fallback) throw new ApiExecutorError("API byte limit is invalid.", "policy");
  return value;
}

function assertSafePath(path: string) {
  for (const part of path.split("/")) {
    let decoded = part;
    for (let depth = 0; depth < 3; depth += 1) {
      let next: string;
      try { next = decodeURIComponent(decoded); } catch { throw new ApiExecutorError("API path encoding is invalid.", "policy", false, "path-invalid"); }
      if (next === "." || next === ".." || next.includes("/") || next.includes("\\")) throw new ApiExecutorError("API path contains traversal or encoded separators.", "policy", false, "path-traversal");
      if (next === decoded) break;
      decoded = next;
    }
  }
}

function assertAuthName(name: string) { if (!name || /[\r\n]/.test(name)) throw new ApiExecutorError("API key name is invalid.", "policy"); }
function forbiddenHeader(name: string) { return /^(host|authorization|cookie|set-cookie|content-length|transfer-encoding|connection|upgrade|te|trailer|proxy-.*|forwarded|x-forwarded-.*|accept-encoding)$/i.test(name); }
function isRedirect(status: number) { return [301, 302, 303, 307, 308].includes(status); }

function serializeBody(body: unknown, contentType: ApiExecutionRequest["contentType"], headers: Headers): string | undefined {
  if (body === undefined) return undefined;
  const type = contentType ?? (typeof body === "string" ? "text/plain" : "application/json");
  headers.set("Content-Type", type);
  if (type === "application/json") return JSON.stringify(body);
  if (type === "application/x-www-form-urlencoded") {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiExecutorError("Form body must be an object.", "policy");
    return new URLSearchParams(Object.entries(body).map(([name, value]) => [name, String(value)])).toString();
  }
  return String(body);
}

function parseBody(bytes: Buffer, contentType: string | null): unknown {
  if (bytes.length === 0) return null;
  const text = bytes.toString("utf8");
  if (contentType?.toLowerCase().includes("json")) { try { return JSON.parse(text); } catch { return { invalidJsonPreview: text }; } }
  if (!contentType || contentType.toLowerCase().startsWith("text/")) return text;
  return { binary: true, byteLength: bytes.length, contentType };
}
