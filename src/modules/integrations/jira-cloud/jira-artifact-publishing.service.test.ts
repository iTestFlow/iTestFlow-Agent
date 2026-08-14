import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "link-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet,
  withTransaction: (work: (client: object) => unknown) => work({ tx: true }),
}));
import * as plainJiraPublishing from "./jira-artifact-publishing.service";

const { publishPlainJiraTestCase } = plainJiraPublishing;

describe("publishPlainJiraTestCase", () => {
  beforeEach(() => vi.clearAllMocks());
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
});
