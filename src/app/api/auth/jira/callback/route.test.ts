import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.consumeState.mockResolvedValue({ returnTo: "/settings/integrations" });
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
    const order = [mocks.consumeState, mocks.exchangeCode, mocks.provision, mocks.storeConnection, mocks.createSession]
      .map((fn) => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
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
});
