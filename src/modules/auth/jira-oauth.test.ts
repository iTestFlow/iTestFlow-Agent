import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AtlassianOAuthError,
  AtlassianReauthorizationRequiredError,
  buildAtlassianAuthorizationUrl,
  exchangeAtlassianAuthorizationCode,
  getAtlassianUserIdentity,
  listAtlassianAccessibleResources,
  refreshAtlassianOAuthTokens,
} from "./jira-oauth";

const tokenResponse = (overrides: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    expires_in: 3600,
    scope: "read:jira-work offline_access",
    token_type: "Bearer",
    ...overrides,
  }), { status: 200, headers: { "content-type": "application/json" } });

describe("Jira Cloud OAuth client", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "https://itestflow.example/api/auth/jira/callback");
  });

  it("builds a least-privilege authorization request — five scopes, no webhook scope", () => {
    const url = new URL(buildAtlassianAuthorizationUrl("opaque-state"));
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://itestflow.example/api/auth/jira/callback");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "offline_access",
      "read:me",
      "read:jira-work",
      "write:jira-work",
      "read:jira-user",
    ]);
    expect(url.toString()).not.toContain("client-secret");
    expect(() => buildAtlassianAuthorizationUrl("  ")).toThrow(AtlassianOAuthError);
  });

  it("fails fast when an OAuth variable is missing, naming it", () => {
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "");
    expect(() => buildAtlassianAuthorizationUrl("state")).toThrow("ATLASSIAN_OAUTH_CLIENT_ID");
  });

  it("exchanges an authorization code without leaking upstream bodies or credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeAtlassianAuthorizationCode("auth-code")).resolves.toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresInSeconds: 3600,
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://auth.atlassian.com/oauth/token");
    expect(request).toMatchObject({
      grant_type: "authorization_code",
      client_id: "client-id",
      client_secret: "client-secret",
      code: "auth-code",
      redirect_uri: "https://itestflow.example/api/auth/jira/callback",
    });

    fetchMock.mockResolvedValueOnce(new Response("upstream secret body", { status: 403 }));
    const error = await exchangeAtlassianAuthorizationCode("bad-code").catch((caught) => caught as Error);
    expect(error).toBeInstanceOf(AtlassianOAuthError);
    // A rejected exchange restarts the login flow; it is not the terminal
    // reauthorization state a dead refresh grant produces — and a burnt code
    // is not cured by waiting, so the message says to start again.
    expect(error).not.toBeInstanceOf(AtlassianReauthorizationRequiredError);
    expect(String(error)).toContain("Start the Jira connection again");
    expect(String(error)).not.toContain("upstream secret body");
    expect(String(error)).not.toContain("client-secret");

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } }));
    const burntCode = await exchangeAtlassianAuthorizationCode("burnt-code").catch((caught) => caught as Error);
    expect(burntCode).not.toBeInstanceOf(AtlassianReauthorizationRequiredError);
    expect(String(burntCode)).toContain("Start the Jira connection again");
  });

  it("requires the rotated refresh token on every refresh", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse({ refresh_token: undefined }));
    vi.stubGlobal("fetch", fetchMock);
    const error = await refreshAtlassianOAuthTokens("refresh-old").catch((caught) => caught as Error);
    // Missing rotation on a 200 is transient by design: the stored token may
    // still be alive inside Atlassian's reuse leeway, and the next refresh
    // will classify terminally if it is not.
    expect(error).toBeInstanceOf(AtlassianOAuthError);
    expect(error).not.toBeInstanceOf(AtlassianReauthorizationRequiredError);
  });

  it("classifies refresh failures: only an invalid_grant body is terminal", async () => {
    // Atlassian's real dead-grant response (403 + invalid_grant) and the RFC
    // 6749 §5.2 shape (400 + invalid_grant) flip terminally, whatever the status.
    for (const status of [400, 401, 403] as const) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }),
        { status, headers: { "content-type": "application/json" } },
      )));
      await expect(refreshAtlassianOAuthTokens("refresh-old")).rejects.toBeInstanceOf(AtlassianReauthorizationRequiredError);
    }
    // A bare 401/403 is invalid_client (a rotated app secret) or an edge/WAF
    // page; 400 invalid_request is a protocol bug; 429 is Auth0 rate limiting
    // hitting exactly when refresh jobs storm; 5xx/network are outages.
    // Re-consent fixes none of those — flipping rows terminal on them would
    // kill the fleet on a 30-minute config skew, so all stay transient.
    const transientCases: Array<[number, string]> = [
      [401, JSON.stringify({ error: "access_denied", error_description: "Unauthorized" })],
      [403, "<html>blocked by edge</html>"],
      [400, JSON.stringify({ error: "invalid_request" })],
      [429, "rate limited"],
      [503, "outage"],
    ];
    for (const [status, body] of transientCases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
      const error = await refreshAtlassianOAuthTokens("refresh-old").catch((caught) => caught as Error);
      expect(error, `status ${status}`).toBeInstanceOf(AtlassianOAuthError);
      expect(error, `status ${status}`).not.toBeInstanceOf(AtlassianReauthorizationRequiredError);
    }

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket reset refresh-old")));
    const network = await refreshAtlassianOAuthTokens("refresh-old").catch((caught) => caught as Error);
    expect(network).toBeInstanceOf(AtlassianOAuthError);
    expect(network).not.toBeInstanceOf(AtlassianReauthorizationRequiredError);
    expect(String(network)).not.toContain("refresh-old");
  });

  it("lists accessible resources unfiltered — trust keys off configured sites, not an env allowlist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: "cloud-a", name: "Site A", url: "https://a.atlassian.net", scopes: ["read:jira-work"] },
      { id: "cloud-b", name: "Site B", url: "https://b.atlassian.net", scopes: [] },
    ]), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(listAtlassianAccessibleResources("access-token")).resolves.toEqual([
      { id: "cloud-a", name: "Site A", url: "https://a.atlassian.net", scopes: ["read:jira-work"] },
      { id: "cloud-b", name: "Site B", url: "https://b.atlassian.net", scopes: [] },
    ]);
  });

  it("resolves the verified user identity from /me", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      account_id: "acct-1", name: "Dana Developer", email: "dana@example.com",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getAtlassianUserIdentity("access-token")).resolves.toEqual({
      accountId: "acct-1", displayName: "Dana Developer", emailAddress: "dana@example.com",
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.atlassian.com/me");
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer access-token" });
  });

  it("names the missing-email condition instead of reading like an outage", async () => {
    // jira_connections.email is NOT NULL and seeded owners match by email, so
    // the user-actionable condition deserves its own message.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      account_id: "acct-1", name: "Dana Developer",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const error = await getAtlassianUserIdentity("access-token").catch((caught) => caught as Error);
    expect(error).toBeInstanceOf(AtlassianOAuthError);
    expect(String(error)).toContain("email");
  });

  it("carries no retired-era references", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/modules/auth/jira-oauth.ts"), "utf8");
    expect(source).not.toContain("ATLASSIAN_ALLOWED_CLOUD_IDS");
    expect(source).not.toContain("manage:jira-webhook");
  });
});
