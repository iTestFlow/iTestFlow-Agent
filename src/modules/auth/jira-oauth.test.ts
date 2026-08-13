import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AtlassianOAuthError,
  buildAtlassianAuthorizationUrl,
  exchangeAtlassianAuthorizationCode,
  getAllowedAtlassianCloudIds,
  getAtlassianUserIdentity,
  isAllowedAtlassianCloudId,
  listAllowedAtlassianResources,
  refreshAtlassianOAuthTokens,
} from "./jira-oauth";

describe("Jira Cloud OAuth", () => {
  beforeEach(() => {
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "https://itestflow.example/api/auth/jira/callback");
    vi.stubEnv("ATLASSIAN_ALLOWED_CLOUD_IDS", " cloud-a,cloud-b, cloud-a ");
  });

  it("builds a least-privilege authorization request with offline access and an opaque state", () => {
    const url = new URL(buildAtlassianAuthorizationUrl("opaque-state"));
    expect(url.origin + url.pathname).toBe("https://auth.atlassian.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe("https://itestflow.example/api/auth/jira/callback");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      "offline_access",
      "read:jira-work",
      "write:jira-work",
      "read:jira-user",
      "manage:jira-webhook",
    ]);
    expect(url.toString()).not.toContain("client-secret");
  });

  it("normalizes the deployment cloud-id allowlist and fails closed when it is empty", () => {
    expect(getAllowedAtlassianCloudIds()).toEqual(["cloud-a", "cloud-b"]);
    expect(isAllowedAtlassianCloudId("cloud-b")).toBe(true);
    expect(isAllowedAtlassianCloudId("cloud-c")).toBe(false);
    vi.stubEnv("ATLASSIAN_ALLOWED_CLOUD_IDS", "  ");
    expect(() => getAllowedAtlassianCloudIds()).toThrow("ATLASSIAN_ALLOWED_CLOUD_IDS");
  });

  it("exchanges an authorization code without leaking upstream bodies or credentials", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 3600,
      scope: "read:jira-work offline_access",
      token_type: "Bearer",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeAtlassianAuthorizationCode("auth-code")).resolves.toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresInSeconds: 3600,
    });
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).toMatchObject({
      grant_type: "authorization_code",
      client_id: "client-id",
      client_secret: "client-secret",
      code: "auth-code",
    });

    fetchMock.mockResolvedValueOnce(new Response("upstream secret body", { status: 403 }));
    const error = await exchangeAtlassianAuthorizationCode("bad-code").catch((caught) => caught);
    expect(error).toBeInstanceOf(AtlassianOAuthError);
    expect(String(error)).not.toContain("upstream secret body");
    expect(String(error)).not.toContain("client-secret");
  });

  it("returns and requires the rotated refresh token", async () => {
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      scope: "offline_access",
      token_type: "Bearer",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(refreshAtlassianOAuthTokens("old-refresh")).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://auth.atlassian.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: "old-refresh",
        client_id: "client-id",
        client_secret: "client-secret",
      }),
      cache: "no-store",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-access",
      expires_in: 3600,
      scope: "offline_access",
      token_type: "Bearer",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(refreshAtlassianOAuthTokens("old-refresh")).rejects.toThrow("rotated refresh token");
  });

  it("returns only allowlisted accessible Jira sites", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([
      { id: "cloud-a", name: "Allowed", url: "https://allowed.atlassian.net", scopes: ["read:jira-work"] },
      { id: "cloud-c", name: "Denied", url: "https://denied.atlassian.net", scopes: ["read:jira-work"] },
    ]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAllowedAtlassianResources("access-secret")).resolves.toEqual([
      { id: "cloud-a", name: "Allowed", url: "https://allowed.atlassian.net", scopes: ["read:jira-work"] },
    ]);
    expect(fetchMock).toHaveBeenCalledWith("https://api.atlassian.com/oauth/token/accessible-resources", {
      headers: { Authorization: "Bearer access-secret", Accept: "application/json" },
      cache: "no-store",
    });
  });

  it("loads the Atlassian account identity through the selected cloud site", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      accountId: "account-123",
      displayName: "Jamie Jira",
      emailAddress: "jamie@example.com",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAtlassianUserIdentity("access-secret", " cloud-a ")).resolves.toEqual({
      accountId: "account-123",
      displayName: "Jamie Jira",
      emailAddress: "jamie@example.com",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.atlassian.com/ex/jira/cloud-a/rest/api/3/myself", {
      headers: { Authorization: "Bearer access-secret", Accept: "application/json" },
      cache: "no-store",
    });

    fetchMock.mockClear();
    await expect(getAtlassianUserIdentity("access-secret", "cloud-c")).rejects.toThrow("not approved");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
