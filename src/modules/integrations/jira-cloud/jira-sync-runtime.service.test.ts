import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(), sqlAll: vi.fn(), sqlRun: vi.fn(), withTransaction: vi.fn(),
  resolvePrincipal: vi.fn(), reconcile: vi.fn(), claim: vi.fn(), complete: vi.fn(), fail: vi.fn(),
  fetchWorkItems: vi.fn(), fetchWorkItemsByIds: vi.fn(), updateIssueFields: vi.fn(), transitionIssue: vi.fn(),
  indexContext: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`, nowIso: () => "2026-08-13T10:00:00.000Z",
  sqlGet: mocks.sqlGet, sqlAll: mocks.sqlAll, sqlRun: mocks.sqlRun, withTransaction: mocks.withTransaction,
}));
vi.mock("@/modules/auth/jira-connection.service", () => ({ resolveJiraSyncPrincipalAccessToken: mocks.resolvePrincipal }));
vi.mock("./jira-reconciliation.service", () => ({ reconcileJiraMapping: mocks.reconcile }));
vi.mock("./jira-sync-operation.service", () => ({
  claimNextJiraSyncOperation: mocks.claim, completeJiraSyncOperation: mocks.complete, failJiraSyncOperation: mocks.fail,
}));
vi.mock("./jira-cloud-adapter", () => ({
  JiraCloudAdapter: class {
    fetchWorkItems = mocks.fetchWorkItems;
    fetchWorkItemsByIds = mocks.fetchWorkItemsByIds;
    updateIssueFields = mocks.updateIssueFields;
    transitionIssue = mocks.transitionIssue;
  },
}));
vi.mock("@/modules/rag/project-context-store.service", () => ({ indexAzureWorkItemsAsProjectContext: mocks.indexContext }));
vi.mock("@/modules/jobs/job-queue.service", () => ({ enqueueJob: mocks.enqueueJob }));

import { retireJiraIssueMapping, runJiraProjectReconciliation } from "./jira-sync-runtime.service";

const remote = {
  id: "QA-7", azureProjectId: "10000", workItemType: "Story", title: "Remote title",
  description: "Remote description", state: "In Progress", tags: ["api"], updatedDate: "2026-08-13T09:00:00.000Z",
  raw: { id: "10007", key: "QA-7", fields: { summary: "Remote title", status: { name: "In Progress" }, labels: ["api"] } },
};

describe("runJiraProjectReconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlRun.mockResolvedValue(1);
    mocks.withTransaction.mockImplementation(async (fn) => fn({ query: vi.fn() }));
    mocks.enqueueJob.mockResolvedValue("retry-job");
    mocks.resolvePrincipal.mockResolvedValue({ userId: "sync-user", accessToken: "access" });
    mocks.sqlGet
      .mockResolvedValueOnce({
        project_id: "project-1", provider_project_id: "10000", provider_project_key: "QA", provider_project_name: "Quality",
        provider_site_id: "cloud-a", provider_site_url: "https://quality.atlassian.net", direction: "two_way",
        field_mapping_json: JSON.stringify([{ localField: "title", jiraField: "summary" }, { localField: "state", jiraField: "status" }]),
        status_mapping_json: JSON.stringify([{ localStatus: "Active", jiraStatus: "In Progress" }]),
      })
      .mockResolvedValueOnce({ id: "local-1", title: "Local title", description: null, acceptance_criteria: null, state: "Active", priority: null, tags: null })
      .mockResolvedValueOnce({ id: "mapping-1", status: "active" });
    mocks.sqlAll.mockResolvedValue([
      { field_name: "title", baseline_json: JSON.stringify("Old title") },
      { field_name: "state", baseline_json: JSON.stringify("Active") },
    ]);
    mocks.fetchWorkItems.mockResolvedValue([remote]);
    mocks.fetchWorkItemsByIds.mockResolvedValue([remote]);
    mocks.reconcile.mockResolvedValue({ blocked: false });
    mocks.claim.mockResolvedValue(null);
  });

  it("loads trusted project configuration and invokes durable reconciliation for scheduled sync", async () => {
    await runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:worker", indexContext: true });
    expect(mocks.resolvePrincipal).toHaveBeenCalledWith("ws-1");
    expect(mocks.fetchWorkItems).toHaveBeenCalledWith({ projectId: "10000", limit: 1000 });
    expect(mocks.reconcile).toHaveBeenCalledWith({
      workspaceId: "ws-1", mappingId: "mapping-1", actor: "system:worker",
      baseline: { title: "Old title", state: "Active" },
      local: { title: "Local title", state: "Active" },
      remote: { title: "Remote title", state: "Active" },
    });
    expect(mocks.indexContext).toHaveBeenCalledWith(expect.objectContaining({
      actor: "system:worker", workItemTypes: [], states: [], allowEmptyFilters: true, mode: "incremental", limit: 1000,
    }));
    const contextAdapter = mocks.indexContext.mock.calls[0][0].adapter;
    await expect(contextAdapter.fetchWorkItems({ projectId: "10000" })).resolves.toEqual([
      expect.objectContaining({ state: "Active" }),
    ]);
  });

  it("limits a webhook reconciliation to the event issue and records completion", async () => {
    await runJiraProjectReconciliation({
      workspaceId: "ws-1", projectId: "project-1", actor: "system:webhook", issueKeys: ["QA-7"], indexContext: false,
    });
    expect(mocks.fetchWorkItemsByIds).toHaveBeenCalledWith({ projectId: "10000", workItemIds: ["QA-7"] });
    expect(mocks.fetchWorkItems).not.toHaveBeenCalled();
    expect(mocks.indexContext).not.toHaveBeenCalled();
  });

  it("applies and completes a durable Jira push operation", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ jira_issue_key: "QA-7", local_entity_id: "local-1" });
    mocks.claim
      .mockResolvedValueOnce({ id: "op-1", mappingId: "mapping-1", field: "title", operation: "push", target: "Local title" })
      .mockResolvedValueOnce(null);
    await runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:worker" });
    expect(mocks.updateIssueFields).toHaveBeenCalledWith({ issueKey: "QA-7", fields: { summary: "Local title" } });
    expect(mocks.complete).toHaveBeenCalledWith({ operationId: "op-1", actor: "system:worker" });
  });

  it("applies a durable pull to the provider-neutral local mirror", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ jira_issue_key: "QA-7", local_entity_id: "local-1" });
    mocks.claim
      .mockResolvedValueOnce({ id: "op-2", mappingId: "mapping-1", field: "state", operation: "pull", target: "Active" })
      .mockResolvedValueOnce(null);
    await runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:worker" });
    expect(mocks.sqlRun).toHaveBeenCalledWith(expect.stringContaining("SET state = @target"), {
      localId: "local-1", target: "Active", now: "2026-08-13T10:00:00.000Z",
    });
    expect(mocks.complete).toHaveBeenCalledWith({ operationId: "op-2", actor: "system:worker" });
  });

  it("atomically pauses a deleted mapping and retires its local mirror", async () => {
    mocks.sqlGet.mockReset().mockResolvedValue({ id: "mapping-1", local_entity_id: "local-1" });
    await retireJiraIssueMapping({ workspaceId: "ws-1", projectId: "project-1", issueKey: "QA-7", actor: "system:webhook" });
    expect(mocks.sqlRun).toHaveBeenCalledWith(expect.stringContaining("sync_status = 'inactive'"), expect.objectContaining({ localId: "local-1" }), expect.anything());
    expect(mocks.sqlRun).toHaveBeenCalledWith(expect.stringContaining("status = 'paused'"), expect.objectContaining({ mappingId: "mapping-1" }), expect.anything());
  });

  it("fails the owning job when a transient operation is requeued", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ jira_issue_key: "QA-7", local_entity_id: "local-1" });
    mocks.claim.mockResolvedValueOnce({ id: "op-3", mappingId: "mapping-1", field: "title", operation: "push", target: "Title" });
    mocks.updateIssueFields.mockRejectedValueOnce(new Error("transient"));
    mocks.fail.mockResolvedValueOnce({ retry: true, runAfter: "2026-08-13T10:00:02.000Z" });
    await expect(runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:webhook" }))
      .resolves.toEqual({ issueCount: 1, operationCount: 0 });
    expect(mocks.enqueueJob).toHaveBeenCalledWith({
      jobType: "jira_sync_operations", workspaceId: "ws-1", projectId: "project-1",
      payload: { projectId: "project-1", operationId: "op-3" }, dedupeKey: "jira_sync_operations:op-3",
      runAfter: "2026-08-13T10:00:02.000Z", maxAttempts: 5, createdByUserId: null,
    });
  });

  it("transitions Jira status through the configured status mapping", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ jira_issue_key: "QA-7", local_entity_id: "local-1" });
    mocks.claim
      .mockResolvedValueOnce({ id: "op-state", mappingId: "mapping-1", field: "state", operation: "push", target: "active" })
      .mockResolvedValueOnce(null);

    await runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:worker" });

    expect(mocks.transitionIssue).toHaveBeenCalledWith({ issueKey: "QA-7", statusName: "In Progress" });
    expect(mocks.complete).toHaveBeenCalledWith({ operationId: "op-state", actor: "system:worker" });
  });

  it("leaves a terminally failed operation unqueued", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ jira_issue_key: "QA-7", local_entity_id: "local-1" });
    mocks.claim
      .mockResolvedValueOnce({ id: "op-terminal", mappingId: "mapping-1", field: "title", operation: "push", target: "Title" })
      .mockResolvedValueOnce(null);
    mocks.updateIssueFields.mockRejectedValueOnce(new Error("terminal"));
    mocks.fail.mockResolvedValueOnce({ retry: false });

    await expect(runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:worker" }))
      .resolves.toEqual({ issueCount: 1, operationCount: 0 });

    expect(mocks.enqueueJob).not.toHaveBeenCalled();
  });

  it("creates a missing local mirror and seeds absent baselines from Jira", async () => {
    mocks.sqlGet.mockReset()
      .mockResolvedValueOnce({
        project_id: "project-1", provider_project_id: "10000", provider_project_key: "QA", provider_project_name: "Quality",
        provider_site_id: "cloud-a", provider_site_url: "https://quality.atlassian.net", direction: "two_way",
        field_mapping_json: JSON.stringify([
          { localField: "title", jiraField: "summary" },
          { localField: "description", jiraField: "description" },
          { localField: "acceptanceCriteria", jiraField: "customfield_10020" },
          { localField: "priority", jiraField: "priority" },
          { localField: "tags", jiraField: "labels" },
        ]),
        status_mapping_json: "[]",
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "local-new", title: "Remote title", description: "Remote description",
        acceptance_criteria: "Approved", state: null, priority: 2, tags: "api; smoke",
      })
      .mockResolvedValueOnce({ id: "mapping-new", status: "active" });
    mocks.sqlAll.mockResolvedValueOnce([]);
    mocks.fetchWorkItems.mockResolvedValueOnce([{
      ...remote,
      acceptanceCriteria: undefined,
      priority: 2,
      tags: ["api", "smoke"],
      raw: { id: 10007, fields: { customfield_10020: "Approved" } },
    }]);

    await runJiraProjectReconciliation({ workspaceId: "ws-1", projectId: "project-1", actor: "system:worker" });

    expect(mocks.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      mappingId: "mapping-new",
      baseline: {
        title: "Remote title", description: "Remote description", acceptanceCriteria: "Approved",
        priority: 2, tags: ["api", "smoke"],
      },
    }));
  });

  it("does nothing when a deleted Jira issue has no local mapping", async () => {
    mocks.sqlGet.mockReset().mockResolvedValueOnce(undefined);

    await retireJiraIssueMapping({ workspaceId: "ws-1", projectId: "project-1", issueKey: "QA-404", actor: "system:webhook" });

    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });
});
