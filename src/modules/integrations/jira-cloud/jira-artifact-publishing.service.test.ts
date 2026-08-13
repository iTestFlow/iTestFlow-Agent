import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: () => "link-1", nowIso: () => "2026-08-13T00:00:00.000Z", sqlGet: mocks.sqlGet,
  withTransaction: (work: (client: object) => unknown) => work({ tx: true }),
}));
import { publishPlainJiraTestCase } from "./jira-artifact-publishing.service";

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
});
