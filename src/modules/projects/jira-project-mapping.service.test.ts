import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`, nowIso: () => "2026-08-13T10:00:00.000Z", sqlGet: mocks.sqlGet,
}));
import { upsertJiraProjectMapping } from "./jira-project-mapping.service";

describe("Jira project mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("anchors a Jira project to the server-resolved Jira workspace", async () => {
    mocks.sqlGet.mockResolvedValue({ id: "project_fixed" });
    await expect(upsertJiraProjectMapping({
      workspaceId: "ws-1", providerId: "jira-cloud", jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality",
    })).resolves.toBe("project_fixed");
    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("INSERT INTO projects");
    expect(sql).toContain("SELECT @id, @jiraProjectId");
    expect(sql).toContain("FROM workspaces w");
    expect(sql).toContain("w.provider_id = 'jira-cloud'");
    expect(sql).toContain("ON CONFLICT (workspace_id, provider_id, provider_project_id)");
    expect(params).toMatchObject({ workspaceId: "ws-1", jiraProjectId: "10000", jiraProjectKey: "QA" });
  });

  it("fails closed when the workspace is not an active Jira workspace", async () => {
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(upsertJiraProjectMapping({
      workspaceId: "azure-ws", providerId: "jira-cloud", jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality",
    })).rejects.toThrow("not available");
  });
});
