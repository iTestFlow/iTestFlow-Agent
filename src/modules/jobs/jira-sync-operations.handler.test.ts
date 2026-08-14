import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reconcile: vi.fn() }));
vi.mock("@/modules/integrations/jira-cloud/jira-sync-runtime.service", () => ({ runJiraProjectReconciliation: mocks.reconcile }));
import type { Job } from "./job-queue.service";
import { runJiraSyncOperations } from "./jira-sync-operations.handler";

const validJob = {
  id: "job-1", workspaceId: "ws-1", projectId: "project-1", jobType: "jira_sync_operations",
  payload: { projectId: "project-1", operationId: "op-1" }, status: "running", priority: 100, attempts: 1, maxAttempts: 5,
  dedupeKey: "jira_sync_operations:op-1", lockedBy: "worker", lockedAt: null,
  runAfter: "2026-08-13T10:00:16.000Z", errorMessage: null, createdByUserId: null,
  createdAt: "2026-08-13T10:00:00.000Z", updatedAt: "2026-08-13T10:00:00.000Z",
} satisfies Job;

describe("runJiraSyncOperations", () => {
it("runs the exact project-scoped durable operation retry", async () => {
  mocks.reconcile.mockResolvedValue({ issueCount: 1, operationCount: 1 });
  await runJiraSyncOperations(validJob);
  expect(mocks.reconcile).toHaveBeenCalledWith({ workspaceId: "ws-1", projectId: "project-1", operationId: "op-1", actor: "system:worker", indexContext: false });
});

it.each([
  [{ ...validJob, workspaceId: null }, "workspace and project"],
  [{ ...validJob, projectId: null }, "workspace and project"],
  [{ ...validJob, payload: { projectId: "other", operationId: "op-1" } }, "does not match"],
  [{ ...validJob, payload: { projectId: "project-1" } }, "operationId"],
])("rejects malformed or cross-project job %#", async (job, message) => {
  await expect(runJiraSyncOperations(job as Job)).rejects.toThrow(message);
});
});
