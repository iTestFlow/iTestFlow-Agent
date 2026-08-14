import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sqlGet: vi.fn(), sqlRun: vi.fn(), reconcile: vi.fn(), retire: vi.fn() }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-08-13T10:00:00.000Z", sqlGet: mocks.sqlGet, sqlRun: mocks.sqlRun,
}));
vi.mock("@/modules/integrations/jira-cloud/jira-sync-runtime.service", () => ({
  runJiraProjectReconciliation: mocks.reconcile, retireJiraIssueMapping: mocks.retire,
}));

import type { Job } from "./job-queue.service";
import { runJiraWebhookReconcile } from "./jira-webhook-reconcile.handler";

const job = {
  id: "job-1", workspaceId: "ws-1", projectId: "project-1", jobType: "jira_webhook_reconcile",
  payload: { eventId: "event-1" }, status: "running", priority: 100, attempts: 1, maxAttempts: 5,
  dedupeKey: "jira_webhook:event-1", lockedBy: "worker", lockedAt: "2026-08-13T10:00:00.000Z",
  runAfter: "2026-08-13T10:00:00.000Z", errorMessage: null, createdByUserId: null,
  createdAt: "2026-08-13T10:00:00.000Z", updatedAt: "2026-08-13T10:00:00.000Z",
} satisfies Job;

describe("runJiraWebhookReconcile", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.sqlRun.mockResolvedValue(1); });

  it("reconciles only the scoped issue and completes the exact durable event", async () => {
    mocks.sqlGet.mockResolvedValue({
      id: "event-1", workspace_id: "ws-1", project_id: "project-1", status: "pending",
      payload_json: JSON.stringify({ issue: { key: "QA-7" } }),
    });
    mocks.reconcile.mockResolvedValue({ issueCount: 1, operationCount: 1 });
    await expect(runJiraWebhookReconcile(job)).resolves.toEqual({ issueCount: 1, operationCount: 1 });
    expect(mocks.reconcile).toHaveBeenCalledWith({
      workspaceId: "ws-1", projectId: "project-1", actor: "system:webhook", issueKeys: ["QA-7"], indexContext: false,
    });
    expect(mocks.sqlRun).toHaveBeenCalledWith(expect.stringContaining("status = 'completed'"), {
      eventId: "event-1", now: "2026-08-13T10:00:00.000Z",
    });
  });

  it("keeps a failed event retryable until the job exhausts its attempts", async () => {
    mocks.sqlGet.mockResolvedValue({
      id: "event-1", workspace_id: "ws-1", project_id: "project-1", status: "pending", payload_json: "{}",
    });
    mocks.reconcile.mockRejectedValue(new Error("secret upstream detail"));
    await expect(runJiraWebhookReconcile(job)).rejects.toThrow("Jira webhook reconciliation failed.");
    expect(mocks.sqlRun).toHaveBeenCalledWith(expect.stringContaining("status = @status"), expect.objectContaining({
      eventId: "event-1", status: "pending", errorCode: "integration_unavailable",
    }));
  });

  it("retires a deleted issue locally without attempting to fetch it from Jira", async () => {
    mocks.sqlGet.mockResolvedValue({
      id: "event-1", workspace_id: "ws-1", project_id: "project-1", status: "pending",
      payload_json: JSON.stringify({ webhookEvent: "jira:issue_deleted", issue: { key: "QA-7" } }),
    });
    mocks.retire.mockResolvedValue(undefined);
    await runJiraWebhookReconcile(job);
    expect(mocks.retire).toHaveBeenCalledWith({ workspaceId: "ws-1", projectId: "project-1", issueKey: "QA-7", actor: "system:webhook" });
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });
});
