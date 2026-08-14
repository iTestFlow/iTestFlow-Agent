import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlAll: vi.fn(), sqlGet: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`, nowIso: () => "2026-08-13T10:00:00.000Z", sqlAll: mocks.sqlAll, sqlGet: mocks.sqlGet,
}));
import * as jiraProjectMapping from "./jira-project-mapping.service";

const { upsertJiraProjectMapping } = jiraProjectMapping;

describe("Jira project mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("anchors a Jira project to the server-resolved Jira workspace", async () => {
    mocks.sqlGet.mockResolvedValue({ id: "project_fixed" });
    await expect(upsertJiraProjectMapping({
      workspaceId: "ws-1", actorUserId: "owner-1", providerId: "jira-cloud", jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality",
    })).resolves.toBe("project_fixed");
    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("INSERT INTO projects");
    expect(sql).toContain("SELECT @id, @jiraProjectId");
    expect(sql).toContain("FROM workspaces w");
    expect(sql).toContain("w.provider_id = 'jira-cloud'");
    expect(sql).toContain("m.role IN ('owner', 'admin')");
    expect(sql).toContain("ON CONFLICT (workspace_id, provider_id, provider_project_id)");
    expect(params).toMatchObject({ workspaceId: "ws-1", jiraProjectId: "10000", jiraProjectKey: "QA" });
  });

  it("fails closed when the workspace is not an active Jira workspace", async () => {
    mocks.sqlGet.mockResolvedValue(undefined);
    await expect(upsertJiraProjectMapping({
      workspaceId: "azure-ws", actorUserId: "member-1", providerId: "jira-cloud", jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality",
    })).rejects.toThrow("not available");
  });

  it("stores normalized field and status mappings only for a Jira project owner or admin", async () => {
    expect(typeof (jiraProjectMapping as Record<string, unknown>).storeJiraProjectSyncConfig).toBe("function");
    mocks.sqlGet.mockResolvedValue({ id: "jirasyncconfig_fixed" });
    const store = (jiraProjectMapping as unknown as { storeJiraProjectSyncConfig(input: unknown): Promise<void> }).storeJiraProjectSyncConfig;

    await store({
      workspaceId: "ws-1", projectId: "project-1", actorUserId: "owner-1", direction: "two_way",
      fieldMappings: [{ localField: " title ", jiraField: " summary " }],
      statusMappings: [{ localStatus: " approved ", jiraStatus: " Done " }],
    });

    const [sql, params] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("INSERT INTO jira_project_sync_configs");
    expect(sql).toContain("wm.role IN ('owner', 'admin')");
    expect(sql).toContain("p.provider_id = 'jira-cloud'");
    expect(JSON.parse(params.fieldMappingJson)).toEqual([{ localField: "title", jiraField: "summary" }]);
    expect(JSON.parse(params.statusMappingJson)).toEqual([{ localStatus: "approved", jiraStatus: "Done" }]);
  });

  it("rejects field pairs the sync worker cannot safely apply", async () => {
    const store = (jiraProjectMapping as unknown as { storeJiraProjectSyncConfig(input: unknown): Promise<void> }).storeJiraProjectSyncConfig;
    await expect(store({
      workspaceId: "ws-1", projectId: "project-1", actorUserId: "owner-1", direction: "two_way",
      fieldMappings: [{ localField: "owner", jiraField: "project" }],
      statusMappings: [{ localStatus: "approved", jiraStatus: "Done" }],
    })).rejects.toThrow("field mapping");
    expect(mocks.sqlGet).not.toHaveBeenCalled();
  });

  it("returns a member-scoped, redacted Jira integration overview", async () => {
    expect(typeof (jiraProjectMapping as Record<string, unknown>).getJiraIntegrationOverview).toBe("function");
    mocks.sqlGet.mockResolvedValue({
      workspace_id: "ws-1", workspace_name: "Quality Cloud", provider_site_name: "Quality Jira",
      provider_site_url: "https://quality.atlassian.net", role: "member", connection_status: "active",
    });
    mocks.sqlAll
      .mockResolvedValueOnce([{ id: "project-1", provider_project_id: "10000", provider_project_key: "QA", provider_project_name: "Quality", backend_type: "xray_cloud", backend_status: "active", config_json: '{"clientId":"client-public","localIdFieldId":"customfield_10001"}', direction: "two_way", field_mapping_json: '[{"localField":"title","jiraField":"summary"}]', status_mapping_json: '[{"localStatus":"approved","jiraStatus":"Done"}]' }])
      .mockResolvedValueOnce([{ id: "mapping-1", project_id: "project-1", jira_issue_key: "QA-7", local_entity_type: "requirement", local_entity_id: "req-1", direction: "two_way", status: "conflict", last_synced_at: null, updated_at: "2026-08-13T09:00:00.000Z" }])
      .mockResolvedValueOnce([{ mapping_id: "mapping-1", project_id: "project-1", field_name: "summary", local_json: '"Local"', remote_json: '"Remote"', updated_at: "2026-08-13T09:00:00.000Z" }])
      .mockResolvedValueOnce([{ id: "link-1", project_id: "project-1", local_artifact_type: "test_case", local_artifact_id: "case-1", remote_artifact_id: "QA-T1", remote_url: "https://quality.atlassian.net/browse/QA-T1", backend_type: "xray_cloud", status: "active", updated_at: "2026-08-13T09:00:00.000Z" }]);
    const getOverview = (jiraProjectMapping as unknown as { getJiraIntegrationOverview(input: unknown): Promise<Record<string, unknown>> }).getJiraIntegrationOverview;

    const overview = await getOverview({ workspaceId: "ws-1", actorUserId: "user-1" });

    expect(overview).toMatchObject({ providerId: "jira-cloud", role: "member", connection: { status: "active" } });
    expect(JSON.stringify(overview)).not.toContain("encrypted_secret");
    expect(JSON.stringify(overview)).not.toContain("client-public");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("JOIN workspace_members");
    for (const [, params] of mocks.sqlAll.mock.calls) expect(params).toMatchObject({ workspaceId: "ws-1" });
  });
});
