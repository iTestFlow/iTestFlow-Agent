import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  consumeSelection: vi.fn(), getIdentity: vi.fn(), provision: vi.fn(), store: vi.fn(), session: vi.fn(),
  cookieGet: vi.fn(), cookieDelete: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/modules/auth/jira-site-selection.service", () => ({ consumeJiraSiteSelection: mocks.consumeSelection }));
vi.mock("@/modules/auth/jira-oauth", () => ({
  getAtlassianUserIdentity: mocks.getIdentity,
  AtlassianOAuthError: class AtlassianOAuthError extends Error {},
  AtlassianReauthorizationRequiredError: class AtlassianReauthorizationRequiredError extends Error {},
}));
vi.mock("@/modules/auth/jira-provisioning.service", () => ({ provisionJiraLogin: mocks.provision }));
vi.mock("@/modules/auth/jira-connection.service", () => ({ storeJiraConnection: mocks.store }));
vi.mock("@/modules/auth/session.service", () => ({ createSession: mocks.session }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.audit }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.cookieGet, delete: mocks.cookieDelete }) }));

import { POST } from "./route";

describe("POST /api/auth/jira/select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieGet.mockReturnValue({ value: "browser-secret" });
    mocks.consumeSelection.mockResolvedValue({
      resource: { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
      accessToken: "access", refreshToken: "refresh", expiresInSeconds: 3600,
      scopes: "offline_access", returnTo: "/settings",
    });
    mocks.getIdentity.mockResolvedValue({ accountId: "acct", displayName: "Jamie", emailAddress: null });
    mocks.provision.mockResolvedValue({ workspaceId: "ws-b", userId: "user-1", role: "owner" });
  });

  it("consumes the browser-bound selection and completes login for the chosen site", async () => {
    const response = await POST(new Request("https://itestflow.example/api/auth/jira/select", {
      method: "POST", headers: { "content-type": "application/json", "user-agent": "vitest" },
      body: JSON.stringify({ continuation: "continuation", cloudId: "cloud-b" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, returnTo: "/settings" });
    expect(mocks.consumeSelection).toHaveBeenCalledWith("continuation", "browser-secret", "cloud-b");
    expect(mocks.store).toHaveBeenCalledWith(expect.objectContaining({ cloudId: "cloud-b", isSyncPrincipal: true }));
    expect(mocks.session).toHaveBeenCalledWith({ workspaceId: "ws-b", userId: "user-1", userAgent: "vitest" });
    expect(mocks.cookieDelete).toHaveBeenCalledWith("itf_jira_oauth");
  });

  it("rejects malformed selection before consuming it", async () => {
    const response = await POST(new Request("https://itestflow.example/api/auth/jira/select", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }));
    expect(response.status).toBe(400);
    expect(mocks.consumeSelection).not.toHaveBeenCalled();
    const invalidJson = await POST(new Request("https://itestflow.example/api/auth/jira/select", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(invalidJson.status).toBe(400);
  });

  it("redacts a replayed selection and stops downstream mutation", async () => {
    mocks.consumeSelection.mockRejectedValueOnce(new Error("selection leaked token detail"));
    const response = await POST(new Request("https://itestflow.example/api/auth/jira/select", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ continuation: "used", cloudId: "cloud-b" }),
    }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("leaked token detail");
    expect(mocks.getIdentity).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });

  it("maps typed Atlassian failures without leaking details", async () => {
    const { AtlassianOAuthError, AtlassianReauthorizationRequiredError } = await import("@/modules/auth/jira-oauth");
    for (const [error, status] of [[new AtlassianOAuthError("secret"), 503], [new AtlassianReauthorizationRequiredError(), 401]] as const) {
      mocks.consumeSelection.mockResolvedValueOnce({
        resource: { id: "cloud-b", name: "B", url: "https://b.atlassian.net", scopes: [] },
        accessToken: "access", refreshToken: "refresh", expiresInSeconds: 3600, scopes: "offline_access", returnTo: "/",
      });
      mocks.getIdentity.mockRejectedValueOnce(error);
      const response = await POST(new Request("https://itestflow.example/api/auth/jira/select", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ continuation: "continuation", cloudId: "cloud-b" }),
      }));
      expect(response.status).toBe(status);
      expect(JSON.stringify(await response.json())).not.toContain("secret");
    }
  });
});
