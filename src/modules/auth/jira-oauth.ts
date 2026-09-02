import "server-only";

import { z } from "zod";

/**
 * Atlassian OAuth 2.0 (3LO) client, restored from the pre-67a111dc era with
 * three deliberate changes for the dual-auth model:
 *   - the webhook-management scope left the scope list (webhooks stayed
 *     removed; polling owns deletion detection).
 *   - the env cloud-ID allowlist stays retired — trust keys off
 *     operator-configured sites, exactly like token login, so
 *     accessible-resources returns unfiltered and the callback verifies the
 *     grant against the state's pinned site.
 *   - refresh-failure classification is explicit: only a dead grant raises
 *     AtlassianReauthorizationRequiredError — identified by the token
 *     endpoint SAYING invalid_grant in its body (RFC 6749 §5.2; Atlassian
 *     returns it on 403, the RFC shape is 400), never by HTTP status alone.
 *     A bare 401/403 is invalid_client (a rotated app secret) or an edge/WAF
 *     page, and 429/5xx/network are outages: operator or infrastructure
 *     trouble that re-consent cannot fix, so flipping rows terminal on them
 *     would kill every OAuth connection over a config skew. Those, malformed
 *     responses, and a 200 missing its rotated refresh token all stay plain
 *     AtlassianOAuthError — transient, the stored row must not be touched (a
 *     missing rotation may still be inside Atlassian's reuse leeway; the next
 *     refresh classifies terminally if not).
 *
 * Env reads stay lazy (requireEnv) as defense in depth; whether OAuth is
 * offered at all is the enablement layer's decision.
 */

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
/**
 * Every Atlassian call is bounded: a refresh runs inside a row-lock
 * transaction holding a pool client, so an unbounded hang could stall every
 * same-workspace principal decision behind it. A timeout surfaces as the
 * transient unavailable error.
 */
const ATLASSIAN_REQUEST_TIMEOUT_MS = 15_000;
export const JIRA_REQUIRED_RESOURCE_SCOPES = [
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
] as const;

const JIRA_OAUTH_SCOPES = [
  "offline_access",
  "read:me",
  ...JIRA_REQUIRED_RESOURCE_SCOPES,
] as const;

export function hasRequiredJiraResourceScopes(scopes: readonly string[]): boolean {
  const granted = new Set(scopes);
  return JIRA_REQUIRED_RESOURCE_SCOPES.every((scope) => granted.has(scope));
}

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().default(""),
  token_type: z.string().default("Bearer"),
});

const AccessibleResourcesSchema = z.array(z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  url: z.string().url(),
  scopes: z.array(z.string()),
}));

const UserIdentitySchema = z.object({
  account_id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().or(z.literal("")).nullish(),
});

export type AtlassianOAuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string;
  tokenType: string;
};

export type AtlassianAccessibleResource = {
  id: string;
  name: string;
  url: string;
  scopes: string[];
};

export type AtlassianUserIdentity = {
  accountId: string;
  displayName: string;
  emailAddress: string;
};

export class AtlassianOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlassianOAuthError";
  }
}

export class AtlassianReauthorizationRequiredError extends AtlassianOAuthError {
  constructor() {
    super("Atlassian authorization must be renewed. Reconnect Jira.");
    this.name = "AtlassianReauthorizationRequiredError";
  }
}

type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

function requireEnv(name: "ATLASSIAN_OAUTH_CLIENT_ID" | "ATLASSIAN_OAUTH_CLIENT_SECRET" | "ATLASSIAN_OAUTH_REDIRECT_URI") {
  const value = process.env[name]?.trim();
  if (!value) throw new AtlassianOAuthError(`${name} is not configured.`);
  return value;
}

function oauthConfig(): OAuthConfig {
  return {
    clientId: requireEnv("ATLASSIAN_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("ATLASSIAN_OAUTH_CLIENT_SECRET"),
    redirectUri: requireEnv("ATLASSIAN_OAUTH_REDIRECT_URI"),
  };
}

export function buildAtlassianAuthorizationUrl(state: string): string {
  if (!state.trim()) throw new AtlassianOAuthError("OAuth state is required.");
  const config = oauthConfig();
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    audience: "api.atlassian.com",
    client_id: config.clientId,
    scope: JIRA_OAUTH_SCOPES.join(" "),
    redirect_uri: config.redirectUri,
    state,
    response_type: "code",
    prompt: "consent",
  }).toString();
  return url.toString();
}

async function requestTokens(payload: Record<string, string>, refreshPath = false): Promise<AtlassianOAuthTokens> {
  const clientId = requireEnv("ATLASSIAN_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("ATLASSIAN_OAUTH_CLIENT_SECRET");
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ...payload,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(ATLASSIAN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AtlassianOAuthError("Atlassian authorization is unavailable. Try again later.");
  }
  if (!response.ok) {
    if (refreshPath && await isDeadGrant(response)) {
      throw new AtlassianReauthorizationRequiredError();
    }
    if (!refreshPath && response.status >= 400 && response.status < 500 && response.status !== 429) {
      // A rejected or burnt authorization code is not cured by waiting; the
      // remedy is a fresh consent flow.
      throw new AtlassianOAuthError("Atlassian rejected the authorization grant. Start the Jira connection again.");
    }
    throw new AtlassianOAuthError("Atlassian authorization failed. Try again later.");
  }
  const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new AtlassianOAuthError("Atlassian returned an invalid OAuth token response.");
  }
  if (!parsed.data.refresh_token) {
    throw new AtlassianOAuthError(
      refreshPath
        ? "Atlassian did not return the required rotated refresh token. Try again later."
        : "Atlassian did not return the required refresh token. Start the Jira connection again.",
    );
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    scope: parsed.data.scope,
    tokenType: parsed.data.token_type,
  };
}

/**
 * A grant is dead only when the token endpoint SAYS so: body error =
 * invalid_grant (RFC 6749 §5.2) — Atlassian returns it on 403, the RFC shape
 * is 400, and 401 is accepted defensively. HTTP status alone never decides:
 * a bare 401 is invalid_client (a rotated app secret) and a body-less 403 is
 * an edge/WAF page — both must stay transient or a config skew terminally
 * flips every OAuth row in the deployment.
 */
async function isDeadGrant(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 401 && response.status !== 403) return false;
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return body?.error === "invalid_grant";
}

export function exchangeAtlassianAuthorizationCode(code: string): Promise<AtlassianOAuthTokens> {
  if (!code.trim()) return Promise.reject(new AtlassianOAuthError("Atlassian authorization code is required."));
  return requestTokens({
    grant_type: "authorization_code",
    code,
    redirect_uri: requireEnv("ATLASSIAN_OAUTH_REDIRECT_URI"),
  });
}

export function refreshAtlassianOAuthTokens(refreshToken: string): Promise<AtlassianOAuthTokens> {
  if (!refreshToken.trim()) return Promise.reject(new AtlassianOAuthError("Atlassian refresh token is required."));
  return requestTokens({ grant_type: "refresh_token", refresh_token: refreshToken }, true);
}

export function listAtlassianAccessibleResources(accessToken: string): Promise<AtlassianAccessibleResource[]> {
  return requestAtlassianJson(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    accessToken,
    AccessibleResourcesSchema,
  );
}

export async function getAtlassianUserIdentity(accessToken: string): Promise<AtlassianUserIdentity> {
  const identity = await requestAtlassianJson(
    "https://api.atlassian.com/me",
    accessToken,
    UserIdentitySchema,
  );
  if (!identity.email) {
    // Provisioning matches seeded owners by email and jira_connections.email
    // is NOT NULL — name the user-actionable condition instead of letting it
    // read like an Atlassian outage.
    throw new AtlassianOAuthError("The Atlassian account does not expose an email address, which iTestFlow requires. Add an email to the Atlassian profile and try again.");
  }
  return {
    accountId: identity.account_id,
    displayName: identity.name,
    emailAddress: identity.email,
  };
}

async function requestAtlassianJson<T>(url: string, accessToken: string, schema: z.ZodType<T>): Promise<T> {
  if (!accessToken.trim()) throw new AtlassianOAuthError("Atlassian access token is required.");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(ATLASSIAN_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AtlassianOAuthError("Atlassian is unavailable. Try again later.");
  }
  if (!response.ok) throw new AtlassianOAuthError("Atlassian rejected the authorized request. Reconnect Jira.");
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AtlassianOAuthError("Atlassian returned an invalid response.");
  return parsed.data;
}
