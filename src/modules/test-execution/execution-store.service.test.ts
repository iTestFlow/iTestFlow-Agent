import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlGet = vi.fn();
const sqlRun = vi.fn();
const enqueueJob = vi.fn();

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: vi.fn((prefix: string) => `${prefix}-1`),
  nowIso: () => "2026-08-14T00:00:00.000Z",
  sqlAll: vi.fn(),
  sqlGet: (...args: unknown[]) => sqlGet(...args),
  sqlRun: (...args: unknown[]) => sqlRun(...args),
  withTransaction: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@/modules/jobs/job-queue.service", () => ({ enqueueJob: (...args: unknown[]) => enqueueJob(...args) }));

import {
  beginFailedExecutionPublicationRetry,
  createExecutionRun,
  finishExecutionPublication,
  recordExecutionPublicationResult,
} from "./execution-store.service";

describe("Playwright execution persistence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sqlRun.mockResolvedValue(1);
    enqueueJob.mockResolvedValue("job-1");
    sqlGet.mockResolvedValue({ job_id: "job-1" });
  });

  it("enqueues a single-attempt non-idempotent browser job", async () => {
    await createExecutionRun({
      workspaceId: "w", projectId: "p", planId: 1, suiteId: 2, requestedByUserId: "u",
      settings: { baseUrl: "https://app.example.com", executionNotes: null, screenshotPolicy: "validation-points" },
      testData: [],
      configSnapshot: {}, job: { userId: "u", scope: { workspaceId: "w", projectId: "p", azureProjectId: "ap", azureProjectName: "P", azureOrganizationUrl: "https://dev.azure.com/o" } },
      cases: [],
    });
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ jobType: "playwright_mcp_execution", maxAttempts: 1 }), expect.any(Object));
    expect(sqlRun).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT INTO playwright_execution_runs[\s\S]*base_url, execution_notes, screenshot_policy/),
      expect.objectContaining({ baseUrl: "https://app.example.com", screenshotPolicy: "validation-points" }),
      expect.any(Object),
    );
  });

  it("reclaims a stale in-progress publication with its durable point receipts", async () => {
    sqlGet.mockResolvedValue({
      id: "pub-1",
      status: "running",
      result_json: [{ testCaseId: 4, testPointId: 5, success: true }],
      updated_at: "2026-08-13T00:00:00.000Z",
    });
    await expect(beginFailedExecutionPublicationRetry("run-1")).resolves.toEqual({
      id: "pub-1",
      leaseToken: "pwlease-1",
      prior: [{ testCaseId: 4, testPointId: 5, success: true }],
    });
    expect(sqlRun).toHaveBeenCalledWith(
      expect.stringMatching(/lease_token = @leaseToken[\s\S]*updated_at = @now/),
      expect.objectContaining({ id: "pub-1", leaseToken: "pwlease-1", now: "2026-08-14T00:00:00.000Z" }),
      expect.any(Object),
    );
  });

  it("fences durable point receipts to the active publication lease", async () => {
    sqlRun.mockResolvedValue(1);
    await expect(recordExecutionPublicationResult("pub-1", "lease-1", {
      testCaseId: 4, testPointId: 5, success: true,
    })).resolves.toBe(true);
    expect(sqlRun).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'running' AND lease_token = @leaseToken/),
      expect.objectContaining({ id: "pub-1", leaseToken: "lease-1" }),
    );
  });

  it("fences publication finalization to the active lease", async () => {
    await finishExecutionPublication({ id: "pub-1", leaseToken: "lease-1", status: "completed", result: [] });
    expect(sqlRun).toHaveBeenCalledWith(
      expect.stringMatching(/status = 'running' AND lease_token = @leaseToken/),
      expect.objectContaining({ id: "pub-1", leaseToken: "lease-1" }),
    );
  });
});
