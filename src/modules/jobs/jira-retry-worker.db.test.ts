import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => ({ update: vi.fn(), fetch: vi.fn() }));
vi.mock("@/modules/auth/jira-connection.service", async (original) => ({
  ...await original<typeof import("@/modules/auth/jira-connection.service")>(),
  resolveJiraSyncPrincipalCredentials: vi.fn(async () => ({
    kind: "api_token", revision: "retry-revision", userId: "retry-owner", email: "owner@example.test", apiToken: "test-token", tokenKind: "scoped", cloudId: "retry-cloud",
  })),
}));
vi.mock("@/modules/integrations/jira-cloud/jira-cloud-adapter", () => ({
  JiraCloudAdapter: class { updateIssueFields = upstream.update; fetchWorkItemsByIds = upstream.fetch; },
}));
vi.mock("@/modules/rag/project-context-store.service", () => ({ indexAzureWorkItemsAsProjectContext: vi.fn() }));

import { IntegrationError } from "@/modules/integrations/core/integration-error";
import { JIRA_SYNC_OPERATIONS, runJiraProjectReconciliation } from "@/modules/integrations/jira-cloud/jira-sync-runtime.service";
import { registerJobHandler } from "./job-handlers";
import { runJiraSyncOperations } from "./jira-sync-operations.handler";
import { enqueueJob } from "./job-queue.service";
import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { processNextJob } from "@/worker/main";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const workspaceId = uniqueTestId("jira_retry_ws");
const projectId = uniqueTestId("jira_retry_project");
const mappingId = uniqueTestId("jira_retry_mapping");
const operationId = uniqueTestId("jira_retry_operation");
const origin = `https://${workspaceId}.atlassian.net`;
const start = new Date("2030-01-01T00:00:00.000Z");
const request = { workspaceId, projectId, actor: "system:worker" };

async function jobRow() {
  return sqlGet<{ id: string; status: string; attempts: number; run_after: string; locked_by: string | null; error_code: string | null }>(
    "SELECT id, status, attempts, run_after, locked_by, error_code FROM jobs WHERE workspace_id = @workspaceId", { workspaceId },
  );
}

describeDb("Jira retry delivery through the real worker and PostgreSQL queue", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: origin });
    await seedProject({ workspaceId, orgUrl: origin, azureProjectId: projectId });
    await sqlRun("UPDATE workspaces SET provider_id = 'jira-cloud', provider_site_id = @workspaceId, provider_site_url = @origin WHERE id = @workspaceId", { workspaceId, origin });
    await sqlRun("UPDATE projects SET provider_id = 'jira-cloud', provider_project_id = '10000', provider_project_key = 'QA', provider_project_name = 'Quality' WHERE id = @projectId", { projectId });
    await sqlRun(`INSERT INTO jira_project_sync_configs (id, workspace_id, project_id, direction, field_mapping_json, status_mapping_json, created_at, updated_at)
      VALUES (@projectId, @workspaceId, @projectId, 'two_way', '[{"localField":"title","jiraField":"summary"}]', '[]', @now, @now)`, { projectId, workspaceId, now: start.toISOString() });
    await sqlRun(`INSERT INTO jira_sync_mappings (id, workspace_id, project_id, jira_issue_id, jira_issue_key, local_entity_type, local_entity_id, direction, status, created_at, updated_at)
      VALUES (@mappingId, @workspaceId, @projectId, '10001', 'QA-1', 'work_item', @mappingId, 'two_way', 'syncing', @now, @now)`, { mappingId, workspaceId, projectId, now: start.toISOString() });
    registerJobHandler(JIRA_SYNC_OPERATIONS, runJiraSyncOperations);
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    upstream.update.mockReset().mockResolvedValue(undefined);
    upstream.fetch.mockReset().mockResolvedValue([]);
    await sqlRun("DELETE FROM jobs WHERE workspace_id = @workspaceId", { workspaceId });
    await sqlRun("DELETE FROM jira_sync_operations WHERE mapping_id = @mappingId", { mappingId });
    await sqlRun("UPDATE jira_sync_mappings SET status = 'syncing' WHERE id = @mappingId", { mappingId });
    await sqlRun(`INSERT INTO jira_sync_operations (id, mapping_id, field_name, operation, target_json, status, run_after, created_at, updated_at)
      VALUES (@operationId, @mappingId, 'title', 'push', '"Updated title"', 'pending', @now, @now, @now)`, { operationId, mappingId, now: start.toISOString() });
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => {
    await sqlRun("DELETE FROM jobs WHERE workspace_id = @workspaceId", { workspaceId });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
    await resetDatabaseForTests();
  });

  async function enqueueExact(maxAttempts = 5) {
    return enqueueJob({ jobType: JIRA_SYNC_OPERATIONS, workspaceId, projectId, payload: { projectId, operationId }, dedupeKey: `${JIRA_SYNC_OPERATIONS}:${operationId}`, maxAttempts });
  }

  it("honors a second 429 deadline and executes the same operation once after that deadline", async () => {
    const limited = new IntegrationError({ code: "integration_rate_limited", message: "Upstream secret must not reach job logs", retryAfterSeconds: 60 });
    upstream.update.mockRejectedValueOnce(limited).mockRejectedValueOnce(limited);
    await runJiraProjectReconciliation({ ...request, issueKeys: ["QA-1"] });
    const first = await jobRow();
    expect(first).toMatchObject({ status: "pending", attempts: 0, run_after: "2030-01-01T00:01:00.000Z" });
    vi.setSystemTime(new Date("2030-01-01T00:01:00.000Z"));
    await expect(processNextJob()).resolves.toBe(true);
    expect(await jobRow()).toMatchObject({ id: first!.id, status: "pending", attempts: 1, run_after: "2030-01-01T00:02:00.000Z", error_code: "integration_rate_limited" });
    vi.setSystemTime(new Date("2030-01-01T00:01:02.000Z"));
    await expect(processNextJob()).resolves.toBe(false);
    expect(upstream.update).toHaveBeenCalledTimes(2);
    vi.setSystemTime(new Date("2030-01-01T00:02:00.000Z"));
    await expect(processNextJob()).resolves.toBe(true);
    expect(await jobRow()).toMatchObject({ id: first!.id, status: "completed", attempts: 2 });
    expect(await sqlGet("SELECT status, attempts FROM jira_sync_operations WHERE id = @operationId", { operationId })).toEqual({ status: "completed", attempts: 3 });
    expect(upstream.update).toHaveBeenCalledTimes(3);
    await expect(processNextJob()).resolves.toBe(false);
  });

  it("repeated early claims preserve a single-attempt job and dedupe until work becomes eligible", async () => {
    const deadline = "2030-01-01T00:01:00.000Z";
    await sqlRun("UPDATE jira_sync_operations SET run_after = @deadline WHERE id = @operationId", { operationId, deadline });
    const id = await enqueueExact(1);
    for (let claim = 0; claim < 3; claim += 1) {
      await sqlRun("UPDATE jobs SET run_after = @now WHERE id = @id", { id, now: start.toISOString() });
      await expect(processNextJob()).resolves.toBe(true);
      expect(await jobRow()).toMatchObject({ id, status: "pending", attempts: 0, run_after: deadline, locked_by: null });
      await expect(enqueueExact(1)).resolves.toBeNull();
    }
    expect(upstream.update).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(deadline));
    await processNextJob();
    expect(await jobRow()).toMatchObject({ id, status: "completed", attempts: 1 });
    expect(upstream.update).toHaveBeenCalledTimes(1);
  });

  it("defers processing work until stale recovery, then recovers a crashed operation", async () => {
    await sqlRun("UPDATE jira_sync_operations SET status = 'processing', attempts = 1, processing_started_at = @now WHERE id = @operationId", { operationId, now: start.toISOString() });
    await enqueueExact();
    await processNextJob();
    const deferred = await jobRow();
    expect(deferred).toMatchObject({ status: "pending", attempts: 0, run_after: "2030-01-01T00:05:00.000Z" });
    expect(upstream.update).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(deferred!.run_after));
    await processNextJob();
    expect(await jobRow()).toMatchObject({ status: "completed", attempts: 1 });
    expect(upstream.update).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "blocked"])("fails %s nonterminal operation lookup instead of falsely completing", async (state) => {
    if (state === "missing") await sqlRun("DELETE FROM jira_sync_operations WHERE id = @operationId", { operationId });
    else await sqlRun("UPDATE jira_sync_mappings SET status = 'paused' WHERE id = @mappingId", { mappingId });
    await enqueueExact(1);
    await processNextJob();
    expect(await jobRow()).toMatchObject({ status: "failed", attempts: 1 });
    expect(upstream.update).not.toHaveBeenCalled();
  });

  it("still exhausts the configured job limit on a real attempted failure", async () => {
    upstream.update.mockRejectedValue(new IntegrationError({ code: "integration_rate_limited", message: "limited", retryAfterSeconds: 60 }));
    await enqueueExact(1);
    await processNextJob();
    expect(await jobRow()).toMatchObject({ status: "failed", attempts: 1 });
    expect(upstream.update).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "failed"])("keeps existing terminal %s operation outcomes without executing again", async (status) => {
    await sqlRun("UPDATE jira_sync_operations SET status = @status WHERE id = @operationId", { status, operationId });
    await sqlRun("UPDATE jira_sync_mappings SET status = 'error' WHERE id = @mappingId", { mappingId });
    await enqueueExact();
    await processNextJob();
    expect(await jobRow()).toMatchObject({ status: "completed", attempts: 1 });
    expect(upstream.update).not.toHaveBeenCalled();
    expect(await sqlGet("SELECT status FROM jira_sync_operations WHERE id = @operationId", { operationId })).toEqual({ status });
  });

  it("terminalizes an exhausted processing operation exactly at its stale deadline", async () => {
    await sqlRun("UPDATE jira_sync_operations SET status = 'processing', attempts = 5, processing_started_at = @now WHERE id = @operationId", { operationId, now: start.toISOString() });
    await enqueueExact();
    await processNextJob();
    expect(await jobRow()).toMatchObject({ status: "pending", attempts: 0, run_after: "2030-01-01T00:05:00.000Z" });
    vi.setSystemTime(new Date("2030-01-01T00:05:00.000Z"));
    await processNextJob();
    expect(await jobRow()).toMatchObject({ status: "completed", attempts: 1 });
    expect(await sqlGet("SELECT status, attempts FROM jira_sync_operations WHERE id = @operationId", { operationId })).toEqual({ status: "failed", attempts: 5 });
    expect(upstream.update).not.toHaveBeenCalled();
  });

  it("does not defer an exact operation belonging to another project", async () => {
    const otherProjectId = uniqueTestId("jira_retry_other_project");
    await seedProject({ workspaceId, orgUrl: origin, azureProjectId: otherProjectId });
    try {
      await sqlRun("UPDATE projects SET provider_id = 'jira-cloud', provider_project_id = '20000', provider_project_key = 'OTHER', provider_project_name = 'Other' WHERE id = @otherProjectId", { otherProjectId });
      await sqlRun(`INSERT INTO jira_project_sync_configs (id, workspace_id, project_id, direction, field_mapping_json, status_mapping_json, created_at, updated_at)
        SELECT @otherProjectId, workspace_id, @otherProjectId, direction, field_mapping_json, status_mapping_json, created_at, updated_at
        FROM jira_project_sync_configs WHERE project_id = @projectId`, { otherProjectId, projectId });
      await sqlRun("UPDATE jira_sync_operations SET run_after = '2030-01-01T00:01:00.000Z' WHERE id = @operationId", { operationId });
      await expect(runJiraProjectReconciliation({ ...request, projectId: otherProjectId, operationId })).rejects.toThrow("The exact Jira sync operation is unavailable for processing.");
      expect(await sqlGet("SELECT status, attempts FROM jira_sync_operations WHERE id = @operationId", { operationId })).toEqual({ status: "pending", attempts: 0 });
      expect(upstream.update).not.toHaveBeenCalled();
    } finally {
      await sqlRun("DELETE FROM projects WHERE id = @otherProjectId", { otherProjectId });
    }
  });
});
