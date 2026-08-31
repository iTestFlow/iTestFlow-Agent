import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(),
  consumeState: vi.fn(),
  exchange: vi.fn(),
  listResources: vi.fn(),
  getIdentity: vi.fn(),
  findSiteById: vi.fn(),
  provision: vi.fn(),
  storeConnection: vi.fn(),
  createSession: vi.fn(),
  writeAuditLog: vi.fn(),
  cookieGet: vi.fn(),
  cookieDelete: vi.fn(),
}));

vi.mock("@/modules/security/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, clientIp: mocks.clientIp }));
vi.mock("@/modules/auth/jira-oauth-state", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-oauth-state")>(),
  consumeJiraOAuthState: mocks.consumeState,
}));
vi.mock("@/modules/auth/jira-oauth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-oauth")>(),
  exchangeAtlassianAuthorizationCode: mocks.exchange,
  listAtlassianAccessibleResources: mocks.listResources,
  getAtlassianUserIdentity: mocks.getIdentity,
}));
vi.mock("@/modules/workspace/workspace.service", () => ({ findActiveJiraSiteById: mocks.findSiteById }));
vi.mock("@/modules/auth/jira-provisioning.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-provisioning.service")>(),
  provisionJiraLogin: mocks.provision,
}));
vi.mock("@/modules/auth/jira-connection.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-connection.service")>(),
  storeJiraConnection: mocks.storeConnection,
}));
vi.mock("@/modules/auth/session.service", () => ({ createSession: mocks.createSession }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet, delete: mocks.cookieDelete }) }));

import { JiraOAuthStateError } from "@/modules/auth/jira-oauth-state";
import { AtlassianOAuthError } from "@/modules/auth/jira-oauth";
import { GET } from "./route";

function request(query = "?state=opaque&code=auth-code") {
  return new Request(`https://itestflow.example/api/auth/jira/callback${query}`, {
    headers: { "user-agent": "vitest" },
  });
}

const consumedState = {
  returnTo: "/dashboards",
  selectedWorkspaceId: "ws-1",
  selectedSiteUrl: "https://quality.atlassian.net",
  selectedCloudId: "cloud-a",
};

function stubEnablement() {
  vi.stubEnv("DATABASE_URL", "");
  vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "");
  vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
  vi.stubEnv("JIRA_LOGIN_METHODS", "");
  vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "https://itestflow.example/api/auth/jira/callback");
}

function expectLoginErrorRedirect(response: Response, code: string) {
  expect(response.status).toBeGreaterThanOrEqual(302);
  const location = new URL(String(response.headers.get("location")));
  expect(location.pathname).toBe("/login");
  expect(location.searchParams.get("error")).toBe(code);
  return location;
}

describe("GET /api/auth/jira/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    stubEnablement();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.clientIp.mockReturnValue("10.0.0.1");
    mocks.cookieGet.mockReturnValue({ value: "binding-cookie" });
    mocks.consumeState.mockResolvedValue({ ...consumedState });
    mocks.exchange.mockResolvedValue({
      accessToken: "access-secret", refreshToken: "refresh-secret", expiresInSeconds: 3600, scope: "read:jira-work", tokenType: "Bearer",
    });
    mocks.listResources.mockResolvedValue([
      { id: "cloud-a", name: "Quality", url: "https://quality.atlassian.net", scopes: [] },
      { id: "cloud-other", name: "Other", url: "https://other.atlassian.net", scopes: [] },
    ]);
    mocks.getIdentity.mockResolvedValue({ accountId: "acct-1", displayName: "Owner", emailAddress: "owner@example.test" });
    mocks.findSiteById.mockResolvedValue({
      workspaceId: "ws-1", cloudId: "cloud-a", name: "quality", siteUrl: "https://quality.atlassian.net",
    });
    mocks.provision.mockResolvedValue({ workspaceId: "ws-1", userId: "user-1", role: "owner" });
    mocks.storeConnection.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue(undefined);
  });

  it("completes the site-verified sign-in: consume, exchange, verify grant, provision, store, session", async () => {
    const response = await GET(request());
    expect(response.status).toBeGreaterThanOrEqual(302);
    expect(String(response.headers.get("location"))).toBe("https://itestflow.example/dashboards");

    expect(mocks.consumeState).toHaveBeenCalledWith("opaque", "binding-cookie");
    expect(mocks.exchange).toHaveBeenCalledWith("auth-code");
    expect(mocks.getIdentity).toHaveBeenCalledWith("access-secret");
    expect(mocks.provision).toHaveBeenCalledWith({
      resource: { cloudId: "cloud-a", siteName: "Quality", siteUrl: "https://quality.atlassian.net" },
      identity: { accountId: "acct-1", displayName: "Owner", emailAddress: "owner@example.test" },
    });
    expect(mocks.storeConnection).toHaveBeenCalledWith({
      credentialKind: "oauth",
      workspaceId: "ws-1",
      userId: "user-1",
      cloudId: "cloud-a",
      email: "owner@example.test",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresInSeconds: 3600,
      isSyncPrincipal: true,
    });
    expect(mocks.createSession).toHaveBeenCalledWith({ workspaceId: "ws-1", userId: "user-1", userAgent: "vitest" });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("itf_jira_oauth");
  });

  it("matches an unpinned seeded workspace by canonical site URL — the adoption path", async () => {
    mocks.findSiteById.mockResolvedValue({
      workspaceId: "ws-1", cloudId: null, name: "quality", siteUrl: "https://quality.atlassian.net",
    });
    const response = await GET(request());
    expect(String(response.headers.get("location"))).toBe("https://itestflow.example/dashboards");
    expect(mocks.storeConnection).toHaveBeenCalledWith(expect.objectContaining({ cloudId: "cloud-a" }));
  });

  it("fails closed mid-flight when the oauth method was disabled after start", async () => {
    vi.stubEnv("JIRA_LOGIN_METHODS", "api_token");
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(mocks.consumeState).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("rate-limits with 429 and Retry-After before any state work", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const response = await GET(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(mocks.consumeState).not.toHaveBeenCalled();
  });

  it("rejects when the consent anchors moved: a re-pinned workspace or a renamed seeded site", async () => {
    // The workspace's pin no longer matches the one captured at start.
    mocks.findSiteById.mockResolvedValue({
      workspaceId: "ws-1", cloudId: "cloud-repinned", name: "quality", siteUrl: "https://quality.atlassian.net",
    });
    expectLoginErrorRedirect(await GET(request()), "jira_site_access");
    expect(mocks.exchange).not.toHaveBeenCalled();

    // A seeded workspace's current URL diverged from the consented URL.
    mocks.consumeState.mockResolvedValue({ ...consumedState, selectedCloudId: null });
    mocks.findSiteById.mockResolvedValue({
      workspaceId: "ws-1", cloudId: null, name: "quality", siteUrl: "https://renamed.atlassian.net",
    });
    expectLoginErrorRedirect(await GET(request()), "jira_site_access");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("clears the binding cookie on error paths, not only on success", async () => {
    mocks.consumeState.mockRejectedValue(new JiraOAuthStateError("used"));
    expectLoginErrorRedirect(await GET(request()), "jira_oauth_state");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("itf_jira_oauth");
  });

  it("redirects to the login error surface for a missing, replayed, or unbound state", async () => {
    expectLoginErrorRedirect(await GET(request("?code=auth-code")), "jira_oauth_state");

    mocks.consumeState.mockRejectedValue(new JiraOAuthStateError("used"));
    expectLoginErrorRedirect(await GET(request()), "jira_oauth_state");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("never silently switches sites: a grant not covering the pinned cloud ID rejects with the site named", async () => {
    mocks.listResources.mockResolvedValue([
      { id: "cloud-other", name: "Other", url: "https://other.atlassian.net", scopes: [] },
    ]);
    const location = expectLoginErrorRedirect(await GET(request()), "jira_site_access");
    expect(location.searchParams.get("site")).toBe("https://quality.atlassian.net");
    expect(mocks.storeConnection).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("rejects when the state's workspace no longer resolves to an active site", async () => {
    mocks.findSiteById.mockResolvedValue(undefined);
    expectLoginErrorRedirect(await GET(request()), "jira_site_access");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("maps transient Atlassian trouble and unexpected failures to distinct login errors", async () => {
    mocks.exchange.mockRejectedValue(new AtlassianOAuthError("Atlassian authorization is unavailable. Try again later."));
    expectLoginErrorRedirect(await GET(request()), "jira_oauth_unavailable");

    mocks.consumeState.mockResolvedValue({ ...consumedState });
    mocks.exchange.mockResolvedValue({
      accessToken: "access-secret", refreshToken: "refresh-secret", expiresInSeconds: 3600, scope: "", tokenType: "Bearer",
    });
    mocks.provision.mockRejectedValue(new Error("db down"));
    expectLoginErrorRedirect(await GET(request()), "jira_oauth_failed");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
