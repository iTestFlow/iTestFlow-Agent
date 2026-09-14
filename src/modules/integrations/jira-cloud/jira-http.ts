import "server-only";

import { IntegrationError, type IntegrationErrorCode } from "../core/integration-error";

/**
 * Which Atlassian API-token kind authenticates a Jira connection. The kinds are
 * URL-incompatible: scoped tokens only work through the api.atlassian.com
 * gateway, classic tokens only against the direct site URL. The kind is
 * detected once at login and stored on the connection.
 */
export type JiraTokenKind = "scoped" | "classic";

export type JiraBasicAuth = { email: string; apiToken: string };

/** Server-only identity of the exact stored credential used for one request. */
export type JiraAccessToken = { accessToken: string; revision: string };
export type JiraAccessTokenSupplier = (options?: { forceRefresh: true; rejectedRevision: string }) => Promise<JiraAccessToken>;
export type JiraUnauthorizedHooks = { onUnauthorized?: (rejectedRevision?: string) => void };

/**
 * How a request authenticates: the stored email+token pair (Basic), or an
 * OAuth bearer supplier owned by the connection service. The supplier is
 * async and consulted per request, so an access token refreshed mid-run is
 * picked up without rebuilding the client; forceRefresh is the 401 retry
 * path, and the supplier must serialize concurrent refreshes itself.
 */
export type JiraAuth =
  | ({ kind: "basic" } & JiraBasicAuth)
  | { kind: "bearer"; getToken: JiraAccessTokenSupplier };

/**
 * The bearer supplier's only legal failure vocabulary. reauthorization_required
 * means the supplier already flipped the connection row terminally — jiraFetch
 * maps it to an auth failure WITHOUT firing the 401 hook, which would write a
 * second, conflicting status on top. unavailable is transient (token-endpoint
 * outage) and must not invalidate anything. Anything else a supplier throws is
 * classified unknown and its message never surfaces.
 */
export class JiraBearerAuthError extends Error {
  readonly reason: "reauthorization_required" | "unavailable";
  constructor(reason: "reauthorization_required" | "unavailable") {
    super(reason === "unavailable"
      ? "The Jira OAuth credential is temporarily unavailable."
      : "The Jira OAuth credential is no longer authorized.");
    this.name = "JiraBearerAuthError";
    this.reason = reason;
  }
}

/** The single base-URL seam every Jira client derives its requests from. OAuth always calls the gateway — the same URL shape as scoped tokens. */
export function jiraApiBase(
  input: { cloudId: string; siteUrl: string } & ({ credentialKind?: "api_token"; tokenKind: JiraTokenKind } | { credentialKind: "oauth" }),
): string {
  return input.credentialKind === "oauth" || input.tokenKind === "scoped"
    ? `https://api.atlassian.com/ex/jira/${encodeURIComponent(input.cloudId.trim())}/rest/api/3`
    : `${input.siteUrl.trim().replace(/\/+$/, "")}/rest/api/3`;
}

export function jiraBasicAuthorization(auth: JiraBasicAuth): string {
  return `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`, "utf8").toString("base64")}`;
}

export function jiraStatusErrorCode(status: number): IntegrationErrorCode {
  return status === 401 ? "integration_auth_failed"
    : status === 403 ? "integration_permission_denied"
    : status === 404 ? "integration_not_found"
    : status === 429 ? "integration_rate_limited"
    : status >= 500 ? "integration_unavailable"
    : "integration_unknown";
}

/**
 * The shared Jira HTTP request: per-kind authorization, status-preserving
 * error classification, Retry-After surfaced on the error for retry
 * scheduling, and the 401 invalidation hook. Error messages never carry
 * credentials or upstream response bodies. 403/429/5xx must never invalidate
 * a credential or trigger a refresh.
 *
 * 401 semantics diverge by kind: a Basic 401 means the stored token is dead —
 * fire the hook, no retry. A bearer 401 is routinely a lapsed ~1h access
 * token — force one refresh and retry once (bodies are strings or FormData,
 * both re-sendable); only a 401 that survives a fresh token fires the hook.
 */
export async function jiraFetch(
  url: string,
  init: RequestInit,
  auth: JiraAuth,
  hooks?: JiraUnauthorizedHooks,
): Promise<Response> {
  let attempt = await requestOnce(url, init, auth);
  if (attempt.response.status === 401 && auth.kind === "bearer") {
    // Free the pooled connection before issuing the retry's new traffic.
    void attempt.response.body?.cancel();
    attempt = await requestOnce(url, init, auth, attempt.revision);
  }
  const { response, revision } = attempt;
  if (!response.ok) {
    if (response.status === 401) hooks?.onUnauthorized?.(revision);
    throw new IntegrationError({
      providerId: "jira-cloud",
      code: jiraStatusErrorCode(response.status),
      message: "Jira Cloud request failed.",
      statusCode: response.status,
      retryAfterSeconds: parseRetryAfterSeconds(response.headers.get("retry-after")),
    });
  }
  return response;
}

async function requestOnce(url: string, init: RequestInit, auth: JiraAuth, rejectedRevision?: string): Promise<{ response: Response; revision?: string }> {
  const token = auth.kind === "bearer" ? await resolveBearerToken(auth, rejectedRevision) : undefined;
  const authorization = auth.kind === "basic"
    ? jiraBasicAuthorization(auth)
    : `Bearer ${token!.accessToken}`;
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    });
    return { response, revision: token?.revision };
  } catch {
    throw new IntegrationError({ providerId: "jira-cloud", code: "integration_unavailable", message: "Jira Cloud is unavailable." });
  }
}

async function resolveBearerToken(
  auth: Extract<JiraAuth, { kind: "bearer" }>,
  rejectedRevision?: string,
): Promise<JiraAccessToken> {
  try {
    return await auth.getToken(rejectedRevision === undefined ? undefined : { forceRefresh: true, rejectedRevision });
  } catch (error) {
    if (error instanceof JiraBearerAuthError && error.reason === "unavailable") {
      throw new IntegrationError({ providerId: "jira-cloud", code: "integration_unavailable", message: "Jira Cloud is unavailable." });
    }
    if (error instanceof JiraBearerAuthError) {
      throw new IntegrationError({ providerId: "jira-cloud", code: "integration_auth_failed", message: "Jira Cloud request failed.", statusCode: 401 });
    }
    // A supplier failure outside the legal vocabulary is a supplier bug:
    // classify unknown (retryable, capped by the job queue) and carry the
    // original as cause for forensics — never in the outward message.
    throw new IntegrationError({ providerId: "jira-cloud", code: "integration_unknown", message: "Jira Cloud request failed.", cause: error });
  }
}

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return undefined;
}
