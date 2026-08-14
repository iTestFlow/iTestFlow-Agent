import { beforeEach, describe, expect, it, vi } from "vitest";

const sqlRun = vi.fn();
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: vi.fn(), nowIso: () => "2026-08-14T00:00:00.000Z", sqlAll: vi.fn(), sqlGet: vi.fn(),
  sqlRun: (...args: unknown[]) => sqlRun(...args), withTransaction: (callback: (client: undefined) => unknown) => callback(undefined),
}));

import { reapStaleJobs, requeueOwnedJobs } from "./job-queue.service";

describe("stale Playwright job recovery", () => {
  beforeEach(() => { vi.resetAllMocks(); sqlRun.mockResolvedValue(1); });

  it("terminalizes the linked execution run when retries are exhausted", async () => {
    await reapStaleJobs();
    expect(sqlRun.mock.calls.some(([query]) => String(query).includes("UPDATE playwright_execution_runs"))).toBe(true);
    expect(sqlRun.mock.calls.some(([query]) => String(query).includes("playwright_mcp_execution"))).toBe(true);
  });

  it("does not requeue single-attempt jobs during graceful shutdown", async () => {
    await requeueOwnedJobs(["job-1"], "worker-1");
    const query = String(sqlRun.mock.calls.at(-1)?.[0]);
    expect(query).toContain("max_attempts <= 1");
    expect(query).toContain("THEN 'failed'");
  });
});
