import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createState: vi.fn(),
  buildUrl: vi.fn(),
  cookieSet: vi.fn(),
  findSite: vi.fn(),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: () => "1.2.3.4",
}));
vi.mock("@/modules/auth/jira-oauth-state", () => ({ createJiraOAuthState: mocks.createState }));
vi.mock("@/modules/auth/jira-oauth", () => ({ buildAtlassianAuthorizationUrl: mocks.buildUrl }));
vi.mock("@/modules/workspace/workspace.service", () => ({ findActiveJiraSiteByUrl: mocks.findSite }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));

import { GET } from "./route";

describe("GET /api/auth/jira/start", () => {
  const savedProviders = process.env.BOOTSTRAP_ENABLED_PROVIDERS;
  const savedClientId = process.env.ATLASSIAN_OAUTH_CLIENT_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    // Auto-detect requires the OAuth client for jira-cloud to be enabled.
    delete process.env.BOOTSTRAP_ENABLED_PROVIDERS;
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "client-1";
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.createState.mockResolvedValue("opaque-state");
    mocks.buildUrl.mockReturnValue("https://auth.atlassian.com/authorize?state=opaque-state");
  });

  afterEach(() => {
    if (savedProviders === undefined) delete process.env.BOOTSTRAP_ENABLED_PROVIDERS;
    else process.env.BOOTSTRAP_ENABLED_PROVIDERS = savedProviders;
    if (savedClientId === undefined) delete process.env.ATLASSIAN_OAUTH_CLIENT_ID;
    else process.env.ATLASSIAN_OAUTH_CLIENT_ID = savedClientId;
  });

  it("persists state and redirects to Atlassian", async () => {
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/start?returnTo=%2Fsettings"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://auth.atlassian.com/authorize?state=opaque-state");
    expect(mocks.createState).toHaveBeenCalledWith("/settings", expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/), null);
    expect(mocks.cookieSet).toHaveBeenCalledWith("itf_jira_oauth", expect.any(String), expect.objectContaining({
      httpOnly: true, sameSite: "lax", path: "/", maxAge: 600,
    }));
    expect(mocks.buildUrl).toHaveBeenCalledWith("opaque-state");
  });

  it("carries a validated pre-selected site into the OAuth state", async () => {
    mocks.findSite.mockResolvedValue({ name: "Quality", siteUrl: "https://quality.atlassian.net" });

    const response = await GET(new Request(
      "https://itestflow.example/api/auth/jira/start?returnTo=%2Fdashboards&site=" +
        encodeURIComponent("https://Quality.Atlassian.Net/"),
    ));

    expect(response.status).toBe(307);
    // The site is normalized before lookup and the stored value is the canonical row value.
    expect(mocks.findSite).toHaveBeenCalledWith("https://quality.atlassian.net");
    expect(mocks.createState).toHaveBeenCalledWith(
      "/dashboards",
      expect.any(String),
      "https://quality.atlassian.net",
    );
  });

  it("rejects a site that is not enabled for this deployment before any state or cookie", async () => {
    mocks.findSite.mockResolvedValue(null);

    const response = await GET(new Request("https://itestflow.example/api/auth/jira/start?site=unknown-site"));

    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("BOOTSTRAP_JIRA_SITES");
    expect(mocks.createState).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("rejects a malformed site with 400 before any lookup", async () => {
    const response = await GET(new Request(
      "https://itestflow.example/api/auth/jira/start?site=" + encodeURIComponent("https://evil.example.com"),
    ));

    expect(response.status).toBe(400);
    expect(mocks.findSite).not.toHaveBeenCalled();
    expect(mocks.createState).not.toHaveBeenCalled();
  });

  it("rate limits before creating state", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/start"));
    expect(response.status).toBe(429);
    expect(mocks.createState).not.toHaveBeenCalled();
  });

  it("fails closed with 403 when Jira Cloud sign-in is disabled, before any state or cookie", async () => {
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "azure-devops";
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/start"));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Jira Cloud sign-in is disabled for this deployment." });
    expect(mocks.createState).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
