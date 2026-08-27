import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeState: vi.fn(),
  exchangeCode: vi.fn(),
  listResources: vi.fn(),
  getIdentity: vi.fn(),
  provision: vi.fn(),
  storeConnection: vi.fn(),
  createSession: vi.fn(),
  writeAuditLog: vi.fn(),
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
  createSelection: vi.fn(),
}));

vi.mock("@/modules/auth/jira-oauth-state", () => ({
  consumeJiraOAuthState: mocks.consumeState,
  JiraOAuthStateError: class JiraOAuthStateError extends Error {},
}));
vi.mock("@/modules/auth/jira-oauth", () => ({
  AtlassianOAuthError: class AtlassianOAuthError extends Error {},
  AtlassianReauthorizationRequiredError: class AtlassianReauthorizationRequiredError extends Error {},
  exchangeAtlassianAuthorizationCode: mocks.exchangeCode,
  listAllowedAtlassianResources: mocks.listResources,
  getAtlassianUserIdentity: mocks.getIdentity,
}));
vi.mock("@/modules/auth/jira-provisioning.service", () => ({ provisionJiraLogin: mocks.provision }));
vi.mock("@/modules/auth/jira-connection.service", () => ({ storeJiraConnection: mocks.storeConnection }));
vi.mock("@/modules/auth/session.service", () => ({ createSession: mocks.createSession }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet, delete: mocks.cookieDelete }) }));
vi.mock("@/modules/auth/jira-site-selection.service", () => ({ createJiraSiteSelection: mocks.createSelection }));

import { GET } from "./route";

describe("GET /api/auth/jira/callback", () => {
  const savedProviders = process.env.BOOTSTRAP_ENABLED_PROVIDERS;
  const savedClientId = process.env.ATLASSIAN_OAUTH_CLIENT_ID;

  afterEach(() => {
    if (savedProviders === undefined) delete process.env.BOOTSTRAP_ENABLED_PROVIDERS;
    else process.env.BOOTSTRAP_ENABLED_PROVIDERS = savedProviders;
    if (savedClientId === undefined) delete process.env.ATLASSIAN_OAUTH_CLIENT_ID;
    else process.env.ATLASSIAN_OAUTH_CLIENT_ID = savedClientId;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Auto-detect requires the OAuth client for jira-cloud to be enabled.
    delete process.env.BOOTSTRAP_ENABLED_PROVIDERS;
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "client-1";
    mocks.consumeState.mockResolvedValue({ returnTo: "/settings/integrations", selectedSiteUrl: null });
    mocks.exchangeCode.mockResolvedValue({
      accessToken: "access-secret", refreshToken: "refresh-secret", expiresInSeconds: 3600,
      scope: "offline_access read:jira-work", tokenType: "Bearer",
    });
    mocks.listResources.mockResolvedValue([
      { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: ["read:jira-work"] },
    ]);
    mocks.getIdentity.mockResolvedValue({ accountId: "account-1", displayName: "Jamie", emailAddress: "j@example.com" });
    mocks.provision.mockResolvedValue({ workspaceId: "ws-1", userId: "user-1", role: "owner" });
    mocks.storeConnection.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue({ sessionId: "sess-1" });
    mocks.cookieGet.mockReturnValue({ value: "browser-secret" });
    mocks.createSelection.mockResolvedValue("continuation-secret");
  });

  it("consumes state then provisions the approved site, stores tokens, creates a session, and redirects locally", async () => {
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code", {
      headers: { "user-agent": "vitest-agent" },
    }));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://itestflow.example/settings/integrations");
    expect(mocks.consumeState).toHaveBeenCalledWith("opaque", "browser-secret");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("itf_jira_oauth");
    expect(mocks.exchangeCode).toHaveBeenCalledWith("auth-code");
    expect(mocks.getIdentity).toHaveBeenCalledWith("access-secret", "cloud-a");
    expect(mocks.storeConnection).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", userId: "user-1", cloudId: "cloud-a",
      accessToken: "access-secret", refreshToken: "refresh-secret", isSyncPrincipal: true,
    }));
    expect(mocks.createSession).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "user-1", userAgent: "vitest-agent" });
    const order = [
      mocks.consumeState,
      mocks.exchangeCode,
      mocks.getIdentity,
      mocks.provision,
      mocks.storeConnection,
      mocks.createSession,
    ]
      .map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("stops all login mutations when Atlassian cannot supply a usable identity", async () => {
    const { AtlassianOAuthError } = await import("@/modules/auth/jira-oauth");
    mocks.getIdentity.mockRejectedValueOnce(new AtlassianOAuthError("identity detail"));

    const response = await GET(new Request(
      "https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code",
    ));

    expect(response.status).toBe(503);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.storeConnection).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("fails closed before token exchange for missing state or code", async () => {
    for (const query of ["?code=auth-code", "?state=opaque"]) {
      const response = await GET(new Request(`https://itestflow.example/api/auth/jira/callback${query}`));
      expect(response.status).toBe(400);
    }
    expect(mocks.consumeState).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it("maps replayed state to a redacted 400 without downstream mutation", async () => {
    const { JiraOAuthStateError } = await import("@/modules/auth/jira-oauth-state");
    mocks.consumeState.mockRejectedValueOnce(new JiraOAuthStateError("sensitive state detail"));
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=replayed&code=auth-code"));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("sensitive state detail");
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("does not provision an unavailable approved site grant", async () => {
    mocks.listResources.mockResolvedValueOnce([]);
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));
    expect(response.status).toBe(403);
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.storeConnection).not.toHaveBeenCalled();
  });

  it("escrows encrypted tokens server-side and redirects multi-site grants to selection", async () => {
    const resources = [
      { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: [] },
      { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
    ];
    mocks.listResources.mockResolvedValueOnce(resources);
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://itestflow.example/login/jira/select?continuation=continuation-secret");
    expect(mocks.createSelection).toHaveBeenCalledWith(expect.objectContaining({
      browserBinding: "browser-secret", resources, accessToken: "access-secret", refreshToken: "refresh-secret",
    }));
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.storeConnection).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("maps typed Atlassian and unknown failures to fixed redacted responses", async () => {
    const { AtlassianOAuthError, AtlassianReauthorizationRequiredError } = await import("@/modules/auth/jira-oauth");
    for (const [error, status] of [
      [new AtlassianOAuthError("secret upstream body"), 503],
      [new AtlassianReauthorizationRequiredError(), 401],
      [new Error("secret internal detail"), 500],
    ] as const) {
      mocks.exchangeCode.mockRejectedValueOnce(error);
      const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));
      expect(response.status).toBe(status);
      expect(JSON.stringify(await response.json())).not.toContain("secret");
    }
  });

  it("fails closed before state consumption when Jira Cloud sign-in is disabled", async () => {
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "azure-devops";

    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));

    expect(response.status).toBe(403);
    expect(mocks.consumeState).not.toHaveBeenCalled();
    expect(mocks.exchangeCode).not.toHaveBeenCalled();
  });

  it("provisions exactly the pre-selected site from a multi-site grant without a selection detour", async () => {
    mocks.consumeState.mockResolvedValue({ returnTo: "/dashboards", selectedSiteUrl: "https://b.atlassian.net" });
    mocks.listResources.mockResolvedValueOnce([
      { id: "cloud-a", name: "A", url: "https://a.atlassian.net", scopes: [] },
      { id: "cloud-b", name: "B", url: "https://B.Atlassian.Net/", scopes: [] }, // matched after normalization
    ]);

    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://itestflow.example/dashboards");
    expect(mocks.provision).toHaveBeenCalledWith(expect.objectContaining({
      resource: expect.objectContaining({ id: "cloud-b" }),
    }));
    expect(mocks.getIdentity).toHaveBeenCalledWith("access-secret", "cloud-b");
    expect(mocks.createSelection).not.toHaveBeenCalled();
  });

  it("never silently switches sites: a pre-selected site outside the grant bounces to the login page", async () => {
    mocks.consumeState.mockResolvedValue({ returnTo: "/dashboards", selectedSiteUrl: "https://chosen.atlassian.net" });
    mocks.listResources.mockResolvedValueOnce([
      { id: "cloud-a", name: "Other", url: "https://other.atlassian.net", scopes: [] },
    ]);

    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("jira_site_access");
    expect(location.searchParams.get("site")).toBe("https://chosen.atlassian.net");
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.storeConnection).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.cookieDelete).toHaveBeenCalledWith("itf_jira_oauth");
  });

  it("bounces a pre-selected site to the login page when the grant has no approved sites at all", async () => {
    mocks.consumeState.mockResolvedValue({ returnTo: "/dashboards", selectedSiteUrl: "https://chosen.atlassian.net" });
    mocks.listResources.mockResolvedValueOnce([]);

    const response = await GET(new Request("https://itestflow.example/api/auth/jira/callback?state=opaque&code=auth-code"));

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").searchParams.get("error")).toBe("jira_site_access");
    expect(mocks.provision).not.toHaveBeenCalled();
  });
});
