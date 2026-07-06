import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { registerJobHandler } from "@/modules/jobs/job-handlers";
import { enqueueJob } from "@/modules/jobs/job-queue.service";
import {
  resetDatabaseForTests,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { processNextJob } from "@/worker/main";
import {
  cleanupFixtures,
  describeDb,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

const workspaceId = uniqueTestId("ws_worker");
const organizationUrl = `https://dev.azure.com/${uniqueTestId("org_worker")}`;
const jobTypes: string[] = [];

describeDb("worker cycle (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (jobTypes.length) {
      await sqlRun(`DELETE FROM jobs WHERE job_type = ANY(@types)`, {
        types: jobTypes.splice(0),
      });
    }
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
    await resetDatabaseForTests();
  });

  it("dispatches a claimed job to its handler and marks it completed", async () => {
    const jobType = uniqueTestId("worker_success");
    jobTypes.push(jobType);
    const handler = vi.fn(async () => undefined);
    registerJobHandler(jobType, handler);
    const jobId = await enqueueJob({
      jobType,
      workspaceId,
      payload: { workItemId: "101" },
      priority: -1000,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(processNextJob()).resolves.toBe(true);

    expect(handler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: jobId,
        workspaceId,
        payload: { workItemId: "101" },
        attempts: 1,
      }),
    );
    expect(await sqlGet<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM jobs WHERE id = @id`,
      { id: jobId },
    )).toEqual({ status: "completed", locked_by: null });
  });

  it("requeues a throwing handler with backoff while attempts remain", async () => {
    const jobType = uniqueTestId("worker_retry");
    jobTypes.push(jobType);
    registerJobHandler(jobType, async () => {
      throw new Error("temporary Azure outage");
    });
    const jobId = await enqueueJob({
      jobType,
      workspaceId,
      priority: -1000,
      maxAttempts: 2,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processNextJob()).resolves.toBe(true);

    const row = await sqlGet<{
      status: string;
      attempts: number;
      run_after: string;
      error_message: string;
      locked_by: string | null;
    }>(
      `SELECT status, attempts, run_after, error_message, locked_by
       FROM jobs WHERE id = @id`,
      { id: jobId },
    );
    expect(row).toMatchObject({
      status: "pending",
      attempts: 1,
      error_message: "temporary Azure outage",
      locked_by: null,
    });
    expect(new Date(row!.run_after).getTime()).toBeGreaterThan(Date.now());
  });

  it("marks a job failed when no handler exists and retries are exhausted", async () => {
    const jobType = uniqueTestId("worker_missing");
    jobTypes.push(jobType);
    const jobId = await enqueueJob({
      jobType,
      workspaceId,
      priority: -1000,
      maxAttempts: 1,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processNextJob()).resolves.toBe(true);

    expect(await sqlGet<{ status: string; error_message: string; locked_by: string | null }>(
      `SELECT status, error_message, locked_by FROM jobs WHERE id = @id`,
      { id: jobId },
    )).toEqual({
      status: "failed",
      error_message: `No handler registered for job type "${jobType}".`,
      locked_by: null,
    });
  });
});
