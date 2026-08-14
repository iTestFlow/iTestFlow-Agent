import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(), resolveAccess: vi.fn(), plainCreate: vi.fn(), xrayCreate: vi.fn(), zephyrCreate: vi.fn(),
  resolveXray: vi.fn(), resolveZephyr: vi.fn(),
}));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "link-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet,
  withTransaction: (work: (client: object) => unknown) => work({ tx: true }),
}));
vi.mock("@/modules/auth/jira-connection.service", () => ({ resolveJiraAccessToken: mocks.resolveAccess }));
vi.mock("./plain-jira-artifact-backend", () => ({ PlainJiraArtifactBackend: class { createTestCase = mocks.plainCreate; } }));
vi.mock("./xray-cloud-backend", () => ({ XrayCloudBackend: class { createTestCase = mocks.xrayCreate; } }));
vi.mock("./zephyr-scale-backend", () => ({ ZephyrScaleBackend: class { createTestCase = mocks.zephyrCreate; } }));
vi.mock("./xray-cloud-config.service", () => ({ resolveXrayCloudConfig: mocks.resolveXray }));
vi.mock("./zephyr-scale-config.service", () => ({ resolveZephyrScaleConfig: mocks.resolveZephyr }));
import * as plainJiraPublishing from "./jira-artifact-publishing.service";

const { publishPlainJiraTestCase } = plainJiraPublishing;

describe("publishPlainJiraTestCase", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("ITESTFLOW_PUBLIC_URL", "https://itestflow.example"); mocks.resolveAccess.mockResolvedValue("access"); });
  const input = {
    workspaceId: "ws-1", projectId: "project-1", actorUserId: "user-1",
    testCase: { localId: "case-1", targetUserStoryId: "QA-7", title: "Checkout", steps: [] },
  };

  it("returns the stable existing remote identity without republishing", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ provider_project_id: "10000" })
      .mockResolvedValueOnce({ remote_artifact_id: "QA-9", remote_url: "https://quality.atlassian.net/browse/QA-9" });
    const backend = { createTestCase: vi.fn() };
    await expect(publishPlainJiraTestCase({ ...input, backend })).resolves.toEqual({ remoteId: "QA-9", remoteUrl: "https://quality.atlassian.net/browse/QA-9", created: false });
    expect(backend.createTestCase).not.toHaveBeenCalled();
  });

  it("publishes once and atomically records the tenant-scoped traceability link", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ provider_project_id: "10000" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "link-1" })
      .mockResolvedValueOnce({ remote_artifact_id: "QA-9", remote_url: "https://quality.atlassian.net/browse/QA-9" });
    const backend = { createTestCase: vi.fn().mockResolvedValue({ success: true, azureTestCaseId: "QA-9" }) };
    await expect(publishPlainJiraTestCase({ ...input, backend, siteUrl: "https://quality.atlassian.net" })).resolves.toMatchObject({ remoteId: "QA-9", created: true });
    expect(backend.createTestCase).toHaveBeenCalledWith({ projectId: "10000", testCase: input.testCase });
    const [insertSql, params] = mocks.sqlGet.mock.calls[2];
    expect(insertSql).toContain("JOIN workspace_members");
    expect(insertSql).toContain("ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id)");
    expect(params).toMatchObject({ workspaceId: "ws-1", projectId: "project-1", userId: "user-1", localId: "case-1" });
    expect(mocks.sqlGet.mock.calls[3][1]).toMatchObject({ id: "link-1", remoteId: "QA-9" });
  });

  it("stores a plain Jira backend configuration without secrets", async () => {
    expect(typeof (plainJiraPublishing as Record<string, unknown>).storePlainJiraArtifactConfig).toBe("function");
    mocks.sqlGet.mockResolvedValue({ id: "config-1" });
    const store = (plainJiraPublishing as unknown as { storePlainJiraArtifactConfig(input: unknown): Promise<void> }).storePlainJiraArtifactConfig;
    await store({ workspaceId: "ws-1", projectId: "project-1", actorUserId: "owner-1", testCaseIssueTypeId: "10001", localIdFieldId: "customfield_10002" });
    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("'plain_jira'");
    expect(sql).toContain("wm.role IN ('owner', 'admin')");
    expect(params.configJson).toBe('{"testCaseIssueTypeId":"10001","localIdFieldId":"customfield_10002"}');
    expect(params).not.toHaveProperty("encryptedSecret");
  });

  it("publishes through the configured plain Jira backend and records a trace link", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({
        backend_type: "plain_jira", config_json: '{"testCaseIssueTypeId":"10001","localIdFieldId":"customfield_10002"}',
        provider_project_id: "10000", provider_project_key: "QA", provider_project_name: "Quality",
        provider_site_id: "cloud-a", provider_site_url: "https://quality.atlassian.net",
      })
      .mockResolvedValueOnce({ provider_project_id: "10000" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "link-1" })
      .mockResolvedValueOnce({ remote_artifact_id: "QA-9", remote_url: "https://quality.atlassian.net/browse/QA-9" });
    mocks.plainCreate.mockResolvedValue({ success: true, azureTestCaseId: "QA-9" });

    await expect(plainJiraPublishing.publishConfiguredJiraTestCases({ ...input, testCases: [input.testCase] }))
      .resolves.toMatchObject({ results: [{ localId: "case-1", azureTestCaseId: "QA-9", success: true }] });

    expect(mocks.plainCreate).toHaveBeenCalledWith({ projectId: "10000", testCase: input.testCase });
  });

  it("passes the Jira project key to the configured Zephyr backend", async () => {
    mocks.resolveZephyr.mockResolvedValue({ apiToken: "token", region: "us", jiraProjectKey: "QA", localIdFieldName: "iTestFlow ID" });
    mocks.sqlGet
      .mockResolvedValueOnce({
        backend_type: "zephyr_scale", config_json: "{}", provider_project_id: "10000", provider_project_key: "QA", provider_project_name: "Quality",
        provider_site_id: "cloud-a", provider_site_url: "https://quality.atlassian.net",
      })
      .mockResolvedValueOnce({ provider_project_id: "10000", provider_project_key: "QA" })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "link-1" })
      .mockResolvedValueOnce({ remote_artifact_id: "QA-T1", remote_url: "https://quality.atlassian.net" });
    mocks.zephyrCreate.mockResolvedValue({ success: true, azureTestCaseId: "QA-T1" });

    await plainJiraPublishing.publishConfiguredJiraTestCases({ ...input, testCases: [input.testCase] });

    expect(mocks.zephyrCreate).toHaveBeenCalledWith({ projectId: "QA", testCase: input.testCase });
  });

  it("rebinds an existing trace when the project switches artifact backend", async () => {
    mocks.resolveXray.mockResolvedValue({ clientId: "client", clientSecret: "secret", jiraProjectId: "10000", jiraProjectKey: "QA", localIdFieldId: "customfield_1" });
    mocks.sqlGet
      .mockResolvedValueOnce({
        backend_type: "xray_cloud", config_json: "{}", provider_project_id: "10000", provider_project_key: "QA", provider_project_name: "Quality",
        provider_site_id: "cloud-a", provider_site_url: "https://quality.atlassian.net",
      })
      .mockResolvedValueOnce({ provider_project_id: "10000", provider_project_key: "QA" })
      .mockResolvedValueOnce({ backend_type: "plain_jira", remote_artifact_id: "QA-9", remote_url: "https://quality.atlassian.net/browse/QA-9" })
      .mockResolvedValueOnce({ id: "link-1" })
      .mockResolvedValueOnce({ remote_artifact_id: "10009", remote_url: "https://quality.atlassian.net/browse/10009" });
    mocks.xrayCreate.mockResolvedValue({ success: true, azureTestCaseId: "10009" });

    await plainJiraPublishing.publishConfiguredJiraTestCases({ ...input, testCases: [input.testCase] });

    expect(mocks.xrayCreate).toHaveBeenCalledWith({ projectId: "10000", testCase: input.testCase });
    expect(mocks.sqlGet.mock.calls[3][0]).toContain("backend_type = excluded.backend_type");
  });
});
