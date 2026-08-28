import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(),
  findSite: vi.fn(),
  resolveResource: vi.fn(),
  authenticate: vi.fn(),
  provision: vi.fn(),
  storeConnection: vi.fn(),
  createSession: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("@/modules/security/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, clientIp: mocks.clientIp }));
vi.mock("@/modules/workspace/workspace.service", () => ({ findActiveJiraSiteByUrl: mocks.findSite }));
vi.mock("@/modules/auth/jira-token-auth.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-token-auth.service")>(),
  resolveJiraSiteResource: mocks.resolveResource,
  authenticateJiraApiToken: mocks.authenticate,
}));
vi.mock("@/modules/auth/jira-provisioning.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-provisioning.service")>(),
  provisionJiraLogin: mocks.provision,
}));
vi.mock("@/modules/auth/jira-connection.service", () => ({ storeJiraConnection: mocks.storeConnection }));
vi.mock("@/modules/auth/session.service", () => ({ createSession: mocks.createSession }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { InvalidJiraTokenError, JiraTokenAuthError, JiraTokenScopeError } from "@/modules/auth/jira-token-auth.service";
import { POST } from "./route";

const resource = { cloudId: "cloud-a", siteName: "quality", siteUrl: "https://quality.atlassian.net" };

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/jira/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "localhost", "user-agent": "vitest", ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = { siteUrl: "quality.atlassian.net", emailAddress: "Owner@Example.Test", apiToken: "token-secret" };

describe("POST /api/auth/jira/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("BOOTSTRAP_ENABLED_PROVIDERS", "");
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "quality|owner@example.test");
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.clientIp.mockReturnValue("10.0.0.1");
    mocks.findSite.mockResolvedValue({ workspaceId: "ws-1", cloudId: null, name: "quality", siteUrl: "https://quality.atlassian.net" });
    mocks.resolveResource.mockResolvedValue(resource);
    mocks.authenticate.mockResolvedValue({
      identity: { accountId: "acc-1", displayName: "Owner", emailAddress: "owner@example.test" },
      tokenKind: "scoped",
    });
    mocks.provision.mockResolvedValue({ workspaceId: "ws-1", userId: "user-1", role: "owner" });
    mocks.storeConnection.mockResolvedValue(undefined);
    mocks.createSession.mockResolvedValue(undefined);
  });

  it("signs in with site, email, and API token, mirroring the Azure login contract", async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, userId: "user-1", workspaceId: "ws-1" });

    expect(mocks.checkRateLimit).toHaveBeenCalledWith("login:10.0.0.1", 10, 5 * 60 * 1000);
    expect(mocks.findSite).toHaveBeenCalledWith("https://quality.atlassian.net");
    expect(mocks.resolveResource).toHaveBeenCalledWith("https://quality.atlassian.net");
    expect(mocks.authenticate).toHaveBeenCalledWith({
      resource, emailAddress: "Owner@Example.Test", apiToken: "token-secret",
    });
    expect(mocks.provision).toHaveBeenCalledWith({
      resource, identity: { accountId: "acc-1", displayName: "Owner", emailAddress: "owner@example.test" },
    });
    expect(mocks.storeConnection).toHaveBeenCalledWith({
      workspaceId: "ws-1", userId: "user-1", cloudId: "cloud-a",
      email: "owner@example.test", apiToken: "token-secret", tokenKind: "scoped",
      isSyncPrincipal: true,
    });
    expect(mocks.createSession).toHaveBeenCalledWith({ userId: "user-1", workspaceId: "ws-1", userAgent: "vitest" });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_LOGIN", workspaceId: "ws-1", actor: "user-1" }));
  });

  it("requests sync-principal status only for owners", async () => {
    mocks.provision.mockResolvedValue({ workspaceId: "ws-1", userId: "user-2", role: "member" });
    await POST(request(validBody));
    expect(mocks.storeConnection).toHaveBeenCalledWith(expect.objectContaining({ isSyncPrincipal: false }));
  });

  it("rate-limits before anything else with a Retry-After", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const response = await POST(request(validBody));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(mocks.findSite).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("rejects a provably cross-origin submission", async () => {
    const response = await POST(request(validBody, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(mocks.findSite).not.toHaveBeenCalled();
  });

  it("accepts a matching same-origin submission", async () => {
    const response = await POST(request(validBody, { origin: "http://localhost" }));
    expect(response.status).toBe(200);
  });

  it("fails closed when Jira sign-in is disabled for the deployment", async () => {
    vi.stubEnv("BOOTSTRAP_JIRA_SITES", "");
    const response = await POST(request(validBody));
    expect(response.status).toBe(403);
    expect(mocks.findSite).not.toHaveBeenCalled();
  });

  it("validates the request shape before any lookup", async () => {
    const response = await POST(request({ ...validBody, emailAddress: "not-an-email" }));
    expect(response.status).toBe(400);
    expect(mocks.findSite).not.toHaveBeenCalled();
  });

  it("maps a malformed JSON body through the same schema validation", async () => {
    const response = await POST(new Request("http://localhost/api/auth/jira/login", {
      method: "POST", headers: { "Content-Type": "application/json", host: "localhost" }, body: "{",
    }));
    expect(response.status).toBe(400);
    expect(mocks.findSite).not.toHaveBeenCalled();
  });

  it("maps an unexpected storage failure to a generic 500 without a session or leaked internals", async () => {
    mocks.storeConnection.mockRejectedValue(new Error("relation jira_connections is on fire"));
    const response = await POST(request(validBody));
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("relation");
    expect(body).not.toContain("token-secret");
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("rejects a non-Atlassian site before any lookup or outbound call", async () => {
    const response = await POST(request({ ...validBody, siteUrl: "https://evil.example.com" }));
    expect(response.status).toBe(400);
    expect(mocks.findSite).not.toHaveBeenCalled();
    expect(mocks.resolveResource).not.toHaveBeenCalled();
  });

  it("fails closed for an unconfigured site WITHOUT sending credentials anywhere or echoing the site", async () => {
    mocks.findSite.mockResolvedValue(null);
    const response = await POST(request({ ...validBody, siteUrl: "unlisted.atlassian.net" }));
    expect(response.status).toBe(403);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("unlisted");
    expect(body).not.toContain("token-secret");
    expect(mocks.resolveResource).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("fails closed when the site resolves to a different cloud ID than the pinned workspace", async () => {
    mocks.findSite.mockResolvedValue({ workspaceId: "ws-1", cloudId: "cloud-other", name: "quality", siteUrl: "https://quality.atlassian.net" });
    const response = await POST(request(validBody));
    expect(response.status).toBe(403);
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it("maps invalid credentials to a sanitized 401", async () => {
    mocks.authenticate.mockRejectedValue(new InvalidJiraTokenError());
    const response = await POST(request(validBody));
    expect(response.status).toBe(401);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("token-secret");
    expect(mocks.provision).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("distinguishes a mis-scoped token from a wrong password", async () => {
    mocks.authenticate.mockRejectedValue(new JiraTokenScopeError());
    const response = await POST(request(validBody));
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).toContain("scopes");
  });

  it("maps an Atlassian outage to a retryable 503", async () => {
    mocks.authenticate.mockRejectedValue(new JiraTokenAuthError("Atlassian is unavailable. Try again later."));
    const response = await POST(request(validBody));
    expect(response.status).toBe(503);
  });

  it("maps a provisioning fail-closed rejection to 403 without a session", async () => {
    const { JiraSiteNotConfiguredError } = await import("@/modules/auth/jira-provisioning.service");
    mocks.provision.mockRejectedValue(new JiraSiteNotConfiguredError());
    const response = await POST(request(validBody));
    expect(response.status).toBe(403);
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
