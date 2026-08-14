import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveWorkspaceRequest: vi.fn(), workspaceRequestError: vi.fn(), getOverview: vi.fn(), fetchProjects: vi.fn(),
  getProvider: vi.fn(), verifyProject: vi.fn(), storeSync: vi.fn(), storePlain: vi.fn(), storeXray: vi.fn(),
  storeZephyr: vi.fn(), resolveConflict: vi.fn(), revokeConnection: vi.fn(),
  resolveAccessToken: vi.fn(), registerWebhook: vi.fn(),
}));
vi.mock("@/modules/workspace/workspace-request", () => ({ resolveWorkspaceRequest: mocks.resolveWorkspaceRequest, workspaceRequestError: mocks.workspaceRequestError }));
vi.mock("@/modules/projects/jira-project-mapping.service", () => ({ getJiraIntegrationOverview: mocks.getOverview, storeJiraProjectSyncConfig: mocks.storeSync }));
vi.mock("@/modules/credentials/scoped-resolution.service", () => ({ getUserWorkManagementProviderOrgLevel: mocks.getProvider }));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ verifyAndUpsertWorkspaceProject: mocks.verifyProject }));
vi.mock("@/modules/integrations/jira-cloud/jira-artifact-publishing.service", () => ({ storePlainJiraArtifactConfig: mocks.storePlain }));
vi.mock("@/modules/integrations/jira-cloud/xray-cloud-config.service", () => ({ storeXrayCloudConfig: mocks.storeXray }));
vi.mock("@/modules/integrations/jira-cloud/zephyr-scale-config.service", () => ({ storeZephyrScaleConfig: mocks.storeZephyr }));
vi.mock("@/modules/integrations/jira-cloud/jira-conflict-resolution.service", () => ({ resolveJiraFieldConflict: mocks.resolveConflict }));
vi.mock("@/modules/auth/jira-connection.service", () => ({ revokeJiraConnection: mocks.revokeConnection, resolveJiraAccessToken: mocks.resolveAccessToken }));
vi.mock("@/modules/integrations/jira-cloud/jira-webhook-registration.service", () => ({ registerJiraProjectWebhook: mocks.registerWebhook }));

import { DELETE, GET, POST } from "./route";

describe("Jira integration settings API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ITESTFLOW_PUBLIC_URL", "https://itestflow.example");
    mocks.resolveWorkspaceRequest.mockResolvedValue({
      userId: "user-1", workspace: { id: "ws-1", providerId: "jira-cloud", providerSiteId: "cloud-a", providerSiteUrl: "https://quality.atlassian.net" },
    });
    mocks.getProvider.mockResolvedValue({ fetchProjects: mocks.fetchProjects });
    mocks.fetchProjects.mockResolvedValue([{ id: "10000", key: "QA", name: "Quality" }]);
    mocks.getOverview.mockResolvedValue({ providerId: "jira-cloud", role: "owner", connection: { status: "active" }, projects: [] });
    mocks.resolveAccessToken.mockResolvedValue("access-token");
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

  it("verifies Jira project selection through the trusted provider", async () => {
    mocks.verifyProject.mockResolvedValue({ projectId: "project-1", providerProjectId: "10000", providerProjectKey: "QA" });
    const response = await POST(request({ action: "select_project", providerProjectId: "10000" }));
    expect(response.status).toBe(200);
    expect(mocks.verifyProject).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), "10000");
    expect(mocks.registerWebhook).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "ws-1", projectId: "project-1", cloudId: expect.any(String), accessToken: "access-token",
      callbackUrl: "https://itestflow.example/api/webhooks/jira",
    }));
    expect(await response.json()).toMatchObject({ ok: true, project: { projectId: "project-1" } });
  });

  it("rejects a non-HTTPS public webhook origin", async () => {
    vi.stubEnv("ITESTFLOW_PUBLIC_URL", "http://itestflow.example");
    mocks.verifyProject.mockResolvedValue({ projectId: "project-1", providerProjectId: "10000", providerProjectKey: "QA" });

    const response = await POST(request({ action: "select_project", providerProjectId: "10000" }));

    expect(response.status).toBe(404);
    expect(mocks.resolveAccessToken).not.toHaveBeenCalled();
    expect(mocks.registerWebhook).not.toHaveBeenCalled();
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

  it("disconnects only the authenticated actor", async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(mocks.revokeConnection).toHaveBeenCalledWith({ workspaceId: "ws-1", actorUserId: "user-1", targetUserId: "user-1" });
  });
});

function request(body: unknown) {
  return new Request("http://localhost/api/integrations/jira", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
