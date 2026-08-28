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

/** The single base-URL seam every Jira client derives its requests from. */
export function jiraApiBase(input: { tokenKind: JiraTokenKind; cloudId: string; siteUrl: string }): string {
  return input.tokenKind === "scoped"
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
 * The shared Jira HTTP request: Basic auth, status-preserving error
 * classification, Retry-After surfaced on the error for retry scheduling, and
 * the 401 invalidation hook. Error messages never carry the credential pair or
 * upstream response bodies. 403/429/5xx must never invalidate a credential —
 * only a plain 401 fires the hook.
 */
export async function jiraFetch(
  url: string,
  init: RequestInit,
  auth: JiraBasicAuth,
  hooks?: { onUnauthorized?: () => void },
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Authorization: jiraBasicAuthorization(auth),
        Accept: "application/json",
        ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new IntegrationError({ providerId: "jira-cloud", code: "integration_unavailable", message: "Jira Cloud is unavailable." });
  }
  if (!response.ok) {
    if (response.status === 401) hooks?.onUnauthorized?.();
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

function parseRetryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return undefined;
}
