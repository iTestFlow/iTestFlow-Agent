import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(), workspaceRequestError: vi.fn(), getOverview: vi.fn(), fetchProjects: vi.fn(),
  getProvider: vi.fn(), verifyProject: vi.fn(), storeSync: vi.fn(), storePlain: vi.fn(), storeXray: vi.fn(),
  storeZephyr: vi.fn(), resolveConflict: vi.fn(), revokeConnection: vi.fn(), storeConnection: vi.fn(),
  resolveResource: vi.fn(), authenticate: vi.fn(), checkRateLimit: vi.fn(), writeAuditLog: vi.fn(),
  getWorkspaceMembership: vi.fn(), isJiraLoginMethodEnabled: vi.fn(),
}));
vi.mock("@/modules/workspace/workspace-request", () => ({ resolveWorkspaceRequest: mocks.resolveWorkspaceRequest, workspaceRequestError: mocks.workspaceRequestError }));
vi.mock("@/modules/projects/jira-project-mapping.service", () => ({ getJiraIntegrationOverview: mocks.getOverview, storeJiraProjectSyncConfig: mocks.storeSync }));
vi.mock("@/modules/credentials/scoped-resolution.service", () => ({ getUserWorkManagementProviderOrgLevel: mocks.getProvider }));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ verifyAndUpsertWorkspaceProject: mocks.verifyProject }));
vi.mock("@/modules/integrations/jira-cloud/jira-artifact-publishing.service", () => ({ storePlainJiraArtifactConfig: mocks.storePlain }));
vi.mock("@/modules/integrations/jira-cloud/xray-cloud-config.service", () => ({ storeXrayCloudConfig: mocks.storeXray }));
vi.mock("@/modules/integrations/jira-cloud/zephyr-scale-config.service", () => ({ storeZephyrScaleConfig: mocks.storeZephyr }));
vi.mock("@/modules/integrations/jira-cloud/jira-conflict-resolution.service", () => ({ resolveJiraFieldConflict: mocks.resolveConflict }));
vi.mock("@/modules/auth/jira-connection.service", () => ({ revokeJiraConnection: mocks.revokeConnection, storeJiraConnection: mocks.storeConnection }));
vi.mock("@/modules/auth/jira-token-auth.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/auth/jira-token-auth.service")>(),
  resolveJiraSiteResource: mocks.resolveResource,
  authenticateJiraApiToken: mocks.authenticate,
}));
vi.mock("@/modules/security/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit, clientIp: vi.fn(() => "10.0.0.1") }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/workspace/workspace-access.service", () => ({ getWorkspaceMembership: mocks.getWorkspaceMembership }));
vi.mock("@/modules/auth/enabled-providers", () => ({ isJiraLoginMethodEnabled: mocks.isJiraLoginMethodEnabled }));

import { DELETE, GET, POST } from "./route";

describe("Jira integration settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "user-1", workspace: { id: "ws-1", providerId: "jira-cloud", providerSiteId: "cloud-a", providerSiteUrl: "https://quality.atlassian.net" },
    });
    mocks.getProvider.mockResolvedValue({ fetchProjects: mocks.fetchProjects });
    mocks.fetchProjects.mockResolvedValue([{ id: "10000", key: "QA", name: "Quality" }]);
    mocks.getOverview.mockResolvedValue({ providerId: "jira-cloud", role: "owner", connection: { status: "active" }, projects: [] });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.resolveResource.mockResolvedValue({ cloudId: "cloud-a", siteName: "quality", siteUrl: "https://quality.atlassian.net" });
    mocks.authenticate.mockResolvedValue({
      identity: { accountId: "acc-1", displayName: "Owner", emailAddress: "owner@example.test" },
      tokenKind: "scoped",
    });
    mocks.getWorkspaceMembership.mockResolvedValue({ role: "owner", status: "active" });
    mocks.storeConnection.mockResolvedValue(undefined);
    mocks.isJiraLoginMethodEnabled.mockResolvedValue(true);
  });

  it("returns server-authorized overview and available Jira projects without secrets", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providerId: "jira-cloud", role: "owner", connection: { status: "active" }, projects: [],
      availableProjects: [{ id: "10000", key: "QA", name: "Quality" }],
    });
    expect(mocks.getOverview).toHaveBeenCalledWith({ workspaceId: "ws-1", actorUserId: "user-1" });
  });

  it("verifies Jira project selection through the trusted provider without any webhook or public URL", async () => {
    mocks.verifyProject.mockResolvedValue({ projectId: "project-1", providerProjectId: "10000", providerProjectKey: "QA" });
    const response = await POST(request({ action: "select_project", providerProjectId: "10000" }));
    expect(response.status).toBe(200);
    expect(mocks.verifyProject).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), "10000");
    expect(await response.json()).toMatchObject({ ok: true, project: { projectId: "project-1" } });
  });

  it("dispatches each backend configuration without returning secret input", async () => {
    const response = await POST(request({
      action: "configure_backend", projectId: "project-1", backendType: "xray_cloud",
      clientId: "client-1", clientSecret: "opaque-secret", localIdFieldId: "customfield_10001",
    }));
    expect(response.status).toBe(200);
    expect(mocks.storeXray).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-1", actorUserId: "user-1", clientSecret: "opaque-secret" }));
    expect(JSON.stringify(await response.json())).not.toContain("opaque-secret");
  });

  it("dispatches sync, plain Jira, and Zephyr configuration branches", async () => {
    expect((await POST(request({
      action: "configure_sync", projectId: "project-1", direction: "two_way",
      fieldMappings: [{ localField: "title", jiraField: "summary" }],
      statusMappings: [{ localStatus: "Active", jiraStatus: "In Progress" }],
    }))).status).toBe(200);
    expect(mocks.storeSync).toHaveBeenCalled();

    expect((await POST(request({
      action: "configure_backend", projectId: "project-1", backendType: "plain_jira",
      testCaseIssueTypeId: "10001", localIdFieldId: "customfield_10002",
    }))).status).toBe(200);
    expect(mocks.storePlain).toHaveBeenCalled();

    expect((await POST(request({
      action: "configure_backend", projectId: "project-1", backendType: "zephyr_scale",
      apiToken: "opaque", region: "eu", localIdFieldName: "iTestFlow ID",
    }))).status).toBe(200);
    expect(mocks.storeZephyr).toHaveBeenCalled();
  });

  it("does not query Jira projects when the current connection is inactive", async () => {
    mocks.getOverview.mockResolvedValueOnce({ providerId: "jira-cloud", role: "owner", connection: { status: "reauthorization_required" }, projects: [] });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.getProvider).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ availableProjects: [] });
  });

  it("maps authorization, provider, validation, and transient failures to fixed statuses", async () => {
    for (const [message, status] of [
      ["not authorized", 403], ["different integration provider", 404], ["duplicate mapping", 400], ["upstream secret", 503],
    ] as const) {
      mocks.resolveWorkspaceRequest.mockRejectedValueOnce(new Error(message));
      const response = await DELETE();
      expect(response.status).toBe(status);
      expect(JSON.stringify(await response.json())).not.toContain("upstream secret");
    }
  });

  it("reports an active artifact publication as a retryable conflict", async () => {
    mocks.storePlain.mockRejectedValueOnce(new Error("A Jira artifact publish is active for this project."));

    const response = await POST(request({
      action: "configure_backend", projectId: "project-1", backendType: "plain_jira",
      testCaseIssueTypeId: "10001", localIdFieldId: "customfield_10002",
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "A Jira artifact publish is active. Retry after it completes." });
  });

  it("preserves the centralized workspace request error response", async () => {
    mocks.resolveWorkspaceRequest.mockRejectedValueOnce(new Error("session"));
    mocks.workspaceRequestError.mockReturnValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    expect((await GET()).status).toBe(401);
  });

  it("queues a member-selected conflict resolution", async () => {
    mocks.resolveConflict.mockResolvedValue({ resolution: "use_remote", mappingStatus: "conflict" });
    const response = await POST(request({ action: "resolve_conflict", mappingId: "mapping-1", field: "summary", resolution: "use_remote" }));
    expect(response.status).toBe(200);
    expect(mocks.resolveConflict).toHaveBeenCalledWith({ workspaceId: "ws-1", mappingId: "mapping-1", field: "summary", resolution: "use_remote", userId: "user-1" });
  });

  it("rejects malformed actions before mutation", async () => {
    const response = await POST(request({ action: "configure_sync", projectId: "project-1", direction: "sideways", fieldMappings: [], statusMappings: [] }));
    expect(response.status).toBe(400);
    expect(mocks.storeSync).not.toHaveBeenCalled();
  });

  it("disconnects only the authenticated actor and audits the revocation", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(mocks.revokeConnection).toHaveBeenCalledWith({ workspaceId: "ws-1", actorUserId: "user-1", targetUserId: "user-1" });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "JIRA_CONNECTION_REVOKED", actor: "user-1" }));
  });

  it("stores a replacement API token after re-validating the pinned cloud ID, with rate limiting and audit", async () => {
    const response = await POST(request({ action: "connect", emailAddress: "Owner@Example.Test", apiToken: "token-secret" }));
    expect(response.status).toBe(200);
    expect(mocks.isJiraLoginMethodEnabled).toHaveBeenCalledOnce();
    expect(mocks.isJiraLoginMethodEnabled).toHaveBeenCalledWith("api_token");
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("jira-connect:user-1", 10, 5 * 60 * 1000);
    expect(mocks.resolveResource).toHaveBeenCalledWith("https://quality.atlassian.net");
    expect(mocks.storeConnection).toHaveBeenCalledWith({
      workspaceId: "ws-1", userId: "user-1", cloudId: "cloud-a",
      email: "owner@example.test", apiToken: "token-secret", tokenKind: "scoped",
      isSyncPrincipal: true,
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "JIRA_CONNECTION_REPLACED" }));
    expect(JSON.stringify(await response.json())).not.toContain("token-secret");
  });

  it("rejects API-token connections before side effects when the method is disabled", async () => {
    mocks.isJiraLoginMethodEnabled.mockResolvedValueOnce(false);

    const response = await POST(request({ action: "connect", emailAddress: "owner@example.test", apiToken: "token-secret" }));

    expect.soft(response.status).toBe(403);
    expect.soft(await response.json()).toEqual({
      error: "Jira API-token connections are disabled for this deployment.",
    });
    expect.soft(mocks.isJiraLoginMethodEnabled).toHaveBeenCalledOnce();
    expect.soft(mocks.isJiraLoginMethodEnabled).toHaveBeenCalledWith("api_token");
    expect.soft(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect.soft(mocks.resolveResource).not.toHaveBeenCalled();
    expect.soft(mocks.authenticate).not.toHaveBeenCalled();
    expect.soft(mocks.storeConnection).not.toHaveBeenCalled();
    expect.soft(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("leaves unrelated settings actions available when API-token connections are disabled", async () => {
    mocks.isJiraLoginMethodEnabled.mockResolvedValue(false);
    mocks.verifyProject.mockResolvedValue({ projectId: "project-1", providerProjectId: "10000", providerProjectKey: "QA" });

    const response = await POST(request({ action: "select_project", providerProjectId: "10000" }));

    expect(response.status).toBe(200);
    expect(mocks.verifyProject).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), "10000");
    expect(mocks.isJiraLoginMethodEnabled).not.toHaveBeenCalled();
  });

  it("fails closed when the configured site no longer resolves to the pinned cloud ID", async () => {
    mocks.resolveResource.mockResolvedValue({ cloudId: "cloud-other", siteName: "quality", siteUrl: "https://quality.atlassian.net" });
    const response = await POST(request({ action: "connect", emailAddress: "owner@example.test", apiToken: "token" }));
    expect(response.status).toBe(409);
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.storeConnection).not.toHaveBeenCalled();
  });

  it("rate-limits token replacement before any outbound call", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 45 });
    const response = await POST(request({ action: "connect", emailAddress: "owner@example.test", apiToken: "token" }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("45");
    expect(mocks.resolveResource).not.toHaveBeenCalled();
  });

  it("maps an invalid replacement token to a sanitized 401 without storing anything", async () => {
    const { InvalidJiraTokenError } = await import("@/modules/auth/jira-token-auth.service");
    mocks.authenticate.mockRejectedValue(new InvalidJiraTokenError());
    const response = await POST(request({ action: "connect", emailAddress: "owner@example.test", apiToken: "wrong" }));
    expect(response.status).toBe(401);
    expect(mocks.storeConnection).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return new Request("http://localhost/api/integrations/jira", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
