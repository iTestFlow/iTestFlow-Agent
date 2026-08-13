import "server-only";

import { z } from "zod";

const AUTHORIZE_URL = "https://auth.atlassian.com/authorize";
const TOKEN_URL = "https://auth.atlassian.com/oauth/token";
const JIRA_OAUTH_SCOPES = [
  "offline_access",
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
  "manage:jira-webhook",
] as const;

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
  accountId: z.string().min(1),
  displayName: z.string().min(1),
  emailAddress: z.string().email().nullish(),
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
  emailAddress: string | null;
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

function oauthClientCredentials(): Pick<OAuthConfig, "clientId" | "clientSecret"> {
  return {
    clientId: requireEnv("ATLASSIAN_OAUTH_CLIENT_ID"),
    clientSecret: requireEnv("ATLASSIAN_OAUTH_CLIENT_SECRET"),
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

export function getAllowedAtlassianCloudIds(): string[] {
  const ids = [...new Set(
    (process.env.ATLASSIAN_ALLOWED_CLOUD_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  if (ids.length === 0) {
    throw new AtlassianOAuthError("ATLASSIAN_ALLOWED_CLOUD_IDS must contain at least one approved Jira Cloud site ID.");
  }
  return ids;
}

export function isAllowedAtlassianCloudId(cloudId: string): boolean {
  return getAllowedAtlassianCloudIds().includes(cloudId.trim());
}

async function requestTokens(payload: Record<string, string>, requireRotatedRefreshToken = false): Promise<AtlassianOAuthTokens> {
  const config = oauthClientCredentials();
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        ...payload,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      cache: "no-store",
    });
  } catch {
    throw new AtlassianOAuthError("Atlassian authorization is unavailable. Try again later.");
  }
  if (!response.ok) {
    if (requireRotatedRefreshToken && (response.status === 401 || response.status === 403)) {
      throw new AtlassianReauthorizationRequiredError();
    }
    throw new AtlassianOAuthError(
      response.status === 401 || response.status === 403
        ? "Atlassian rejected the authorization grant. Start the Jira connection again."
        : "Atlassian authorization failed. Try again later.",
    );
  }
  const parsed = TokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new AtlassianOAuthError("Atlassian returned an invalid OAuth token response.");
  }
  if (!parsed.data.refresh_token) {
    throw new AtlassianOAuthError(
      requireRotatedRefreshToken
        ? "Atlassian did not return the required rotated refresh token. Reauthorize the Jira connection."
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

export async function listAllowedAtlassianResources(accessToken: string): Promise<AtlassianAccessibleResource[]> {
  const resources = await requestAtlassianJson(
    "https://api.atlassian.com/oauth/token/accessible-resources",
    accessToken,
    AccessibleResourcesSchema,
  );
  const allowed = new Set(getAllowedAtlassianCloudIds());
  return resources.filter((resource) => allowed.has(resource.id));
}

export async function getAtlassianUserIdentity(
  accessToken: string,
  cloudId: string,
): Promise<AtlassianUserIdentity> {
  const normalizedCloudId = cloudId.trim();
  if (!normalizedCloudId) throw new AtlassianOAuthError("Atlassian cloud site ID is required.");
  if (!isAllowedAtlassianCloudId(normalizedCloudId)) {
    throw new AtlassianOAuthError("This Jira Cloud site is not approved for this deployment.");
  }
  const identity = await requestAtlassianJson(
    `https://api.atlassian.com/ex/jira/${encodeURIComponent(normalizedCloudId)}/rest/api/3/myself`,
    accessToken,
    UserIdentitySchema,
  );
  return { ...identity, emailAddress: identity.emailAddress ?? null };
}

async function requestAtlassianJson<T>(url: string, accessToken: string, schema: z.ZodType<T>): Promise<T> {
  if (!accessToken.trim()) throw new AtlassianOAuthError("Atlassian access token is required.");
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new AtlassianOAuthError("Atlassian is unavailable. Try again later.");
  }
  if (!response.ok) throw new AtlassianOAuthError("Atlassian rejected the authorized request. Reconnect Jira.");
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AtlassianOAuthError("Atlassian returned an invalid response.");
  return parsed.data;
}
