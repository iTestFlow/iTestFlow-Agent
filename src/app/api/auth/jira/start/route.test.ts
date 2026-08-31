import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(),
  findSite: vi.fn(),
  createState: vi.fn(),
  buildAuthorizeUrl: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/modules/security/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, clientIp: mocks.clientIp }));
vi.mock("@/modules/workspace/workspace.service", () => ({ findActiveJiraSiteByUrl: mocks.findSite }));
vi.mock("@/modules/auth/jira-oauth-state", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-oauth-state")>(),
  createJiraOAuthState: mocks.createState,
}));
vi.mock("@/modules/auth/jira-oauth", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-oauth")>(),
  buildAtlassianAuthorizationUrl: mocks.buildAuthorizeUrl,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));

import { GET } from "./route";

function request(query: string) {
  return new Request(`http://localhost/api/auth/jira/start${query}`);
}

function stubOAuthEnv() {
  vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "client-id");
  vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", "client-secret");
  vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "https://itestflow.example/api/auth/jira/callback");
}

describe("GET /api/auth/jira/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "");
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
    vi.stubEnv("JIRA_LOGIN_METHODS", "");
    stubOAuthEnv();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.clientIp.mockReturnValue("10.0.0.1");
    mocks.findSite.mockResolvedValue({
      workspaceId: "ws-1", cloudId: "cloud-a", name: "quality", siteUrl: "https://quality.atlassian.net",
    });
    mocks.createState.mockResolvedValue("opaque-state");
    mocks.buildAuthorizeUrl.mockReturnValue("https://auth.atlassian.com/authorize?state=opaque-state");
  });

  it("creates a site-bound state, sets the binding cookie, and redirects to Atlassian", async () => {
    const response = await GET(request("?site=quality.atlassian.net&returnTo=%2Fsettings"));
    expect(response.status).toBeGreaterThanOrEqual(302);
    expect(response.headers.get("location")).toBe("https://auth.atlassian.com/authorize?state=opaque-state");

    expect(mocks.findSite).toHaveBeenCalledWith("https://quality.atlassian.net");
    const [returnTo, binding, selection] = mocks.createState.mock.calls[0];
    expect(returnTo).toBe("/settings");
    expect(String(binding).length).toBeGreaterThanOrEqual(40);
    expect(selection).toEqual({ workspaceId: "ws-1", siteUrl: "https://quality.atlassian.net", cloudId: "cloud-a" });
    expect(mocks.buildAuthorizeUrl).toHaveBeenCalledWith("opaque-state");
    const [cookieName, cookieValue, cookieOptions] = mocks.cookieSet.mock.calls[0];
    expect(cookieName).toBe("itf_jira_oauth");
    expect(cookieValue).toBe(binding);
    expect(cookieOptions).toMatchObject({ httpOnly: true, sameSite: "lax", maxAge: 600 });
  });

  it("defaults returnTo to the dashboards", async () => {
    await GET(request("?site=quality.atlassian.net"));
    expect(mocks.createState.mock.calls[0][0]).toBe("/dashboards");
  });

  it("is dead weight when the oauth method is not enabled — no state, no cookie, no upstream", async () => {
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_ID", "");
    vi.stubEnv("ATLASSIAN_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("ATLASSIAN_OAUTH_REDIRECT_URI", "");
    const response = await GET(request("?site=quality.atlassian.net"));
    expect(response.status).toBe(403);
    expect(mocks.createState).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("requires the site: missing or invalid is 400, unconfigured is 403 fail-closed", async () => {
    expect((await GET(request(""))).status).toBe(400);
    expect((await GET(request("?site=%20"))).status).toBe(400);
    expect((await GET(request("?site=http%3A%2F%2Fevil.example"))).status).toBe(400);

    mocks.findSite.mockResolvedValue(undefined);
    const response = await GET(request("?site=other.atlassian.net"));
    expect(response.status).toBe(403);
    expect(mocks.createState).not.toHaveBeenCalled();
  });

  it("rate-limits with 429 and Retry-After", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const response = await GET(request("?site=quality.atlassian.net"));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
  });
});
