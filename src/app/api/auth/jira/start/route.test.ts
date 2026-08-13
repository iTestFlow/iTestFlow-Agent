import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  createState: vi.fn(),
  buildUrl: vi.fn(),
  cookieSet: vi.fn(),
}));

vi.mock("@/modules/security/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: () => "1.2.3.4",
}));
vi.mock("@/modules/auth/jira-oauth-state", () => ({ createJiraOAuthState: mocks.createState }));
vi.mock("@/modules/auth/jira-oauth", () => ({ buildAtlassianAuthorizationUrl: mocks.buildUrl }));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));

import { GET } from "./route";

describe("GET /api/auth/jira/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    mocks.createState.mockResolvedValue("opaque-state");
    mocks.buildUrl.mockReturnValue("https://auth.atlassian.com/authorize?state=opaque-state");
  });

  it("persists state and redirects to Atlassian", async () => {
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/start?returnTo=%2Fsettings"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://auth.atlassian.com/authorize?state=opaque-state");
    expect(mocks.createState).toHaveBeenCalledWith("/settings", expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/));
    expect(mocks.cookieSet).toHaveBeenCalledWith("itf_jira_oauth", expect.any(String), expect.objectContaining({
      httpOnly: true, sameSite: "lax", path: "/", maxAge: 600,
    }));
    expect(mocks.buildUrl).toHaveBeenCalledWith("opaque-state");
  });

  it("rate limits before creating state", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const response = await GET(new Request("https://itestflow.example/api/auth/jira/start"));
    expect(response.status).toBe(429);
    expect(mocks.createState).not.toHaveBeenCalled();
  });
});
