import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import { registerJobHandler } from "@/modules/jobs/job-handlers";
import { enqueueJob, type Job } from "@/modules/jobs/job-queue.service";
import { PROJECT_KNOWLEDGE_JOB } from "@/modules/jobs/project-knowledge-jobs.service";
import {
  resetDatabaseForTests,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { dispatchReadyKnowledgeJobs, processNextJob, waitForActiveJobs } from "@/worker/main";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

const workspaceId = uniqueTestId("ws_worker");
const organizationUrl = `https://dev.azure.com/${uniqueTestId("org_worker")}`;
const siblingWorkspaceId = uniqueTestId("ws_worker_sibling");
const siblingOrganizationUrl = `https://dev.azure.com/${uniqueTestId("org_worker_sibling")}`;
const jobTypes: string[] = [];
const jobIds: string[] = [];

describeDb("worker cycle (DB-backed)", () => {
  beforeAll(async () => {
    // Sweep this suite's leftovers from a crashed prior local run: claimNextJob is a
    // global scan ordered by priority/created_at, so a stale pending priority -1000 job
    // (older created_at) would be claimed before this run's jobs and fail dispatch.
    await sqlRun(`DELETE FROM jobs WHERE job_type LIKE ANY(@patterns)`, {
      patterns: ["worker_success_%", "worker_retry_%", "worker_missing_%"],
    });
    // The knowledge dispatcher claims (and stale-reaps) every ready job of the
    // literal type, so stray active knowledge rows would be picked up too.
    await sqlRun(`DELETE FROM jobs WHERE job_type = @t AND status IN ('pending', 'running')`, {
      t: PROJECT_KNOWLEDGE_JOB,
    });
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
    await seedWorkspace({ id: siblingWorkspaceId, orgUrl: siblingOrganizationUrl });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (jobTypes.length) {
      await sqlRun(`DELETE FROM jobs WHERE job_type = ANY(@types)`, {
        types: jobTypes.splice(0),
      });
    }
    if (jobIds.length) {
      await sqlRun(`DELETE FROM jobs WHERE id = ANY(@ids)`, { ids: jobIds.splice(0) });
    }
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId, siblingWorkspaceId], userIds: [] });
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
      expect.objectContaining({
        signal: expect.anything(),
        updateProgress: expect.any(Function),
        workerId: expect.any(String),
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

  it("leaves unsupported job types pending for a capable worker", async () => {
    const jobType = uniqueTestId("worker_missing");
    jobTypes.push(jobType);
    const jobId = await enqueueJob({
      jobType,
      workspaceId,
      priority: -1000,
      maxAttempts: 1,
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processNextJob()).resolves.toBe(false);

    expect(await sqlGet<{
      status: string;
      attempts: number;
      error_message: string | null;
      locked_by: string | null;
    }>(
      `SELECT status, attempts, error_message, locked_by FROM jobs WHERE id = @id`,
      { id: jobId },
    )).toEqual({
      status: "pending",
      attempts: 0,
      error_message: null,
      locked_by: null,
    });
  });

  /** Deferred knowledge handler: stays running until the test resolves it per job. */
  function registerDeferredKnowledgeHandler() {
    const resolvers = new Map<string, () => void>();
    const handler = vi.fn(
      (job: Job) => new Promise<void>((resolve) => { resolvers.set(job.id, () => resolve()); }),
    );
    registerJobHandler(PROJECT_KNOWLEDGE_JOB, handler);
    return { handler, finishAll: () => { for (const resolve of resolvers.values()) resolve(); } };
  }

  async function enqueueKnowledgeBuild(input: { workspaceId: string; orgUrl: string; projectId: string }) {
    await seedProject({ workspaceId: input.workspaceId, orgUrl: input.orgUrl, azureProjectId: input.projectId });
    const id = await enqueueJob({
      jobType: PROJECT_KNOWLEDGE_JOB,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      payload: { projectId: input.projectId, operation: "build" },
      dedupeKey: `project_knowledge:${input.projectId}`,
      priority: -1000,
    });
    jobIds.push(id!);
    return id!;
  }

  it("starts builds for distinct projects in the same workspace before either finishes", async () => {
    const { handler, finishAll } = registerDeferredKnowledgeHandler();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const a = await enqueueKnowledgeBuild({ workspaceId, orgUrl: organizationUrl, projectId: uniqueTestId("proj_pk_a") });
    const b = await enqueueKnowledgeBuild({ workspaceId, orgUrl: organizationUrl, projectId: uniqueTestId("proj_pk_b") });

    await expect(dispatchReadyKnowledgeJobs()).resolves.toBe(2);
    // Both handlers were invoked while both jobs are still running: neither
    // build queued behind the other.
    expect(handler).toHaveBeenCalledTimes(2);
    for (const id of [a, b]) {
      expect(await sqlGet<{ status: string }>(`SELECT status FROM jobs WHERE id = @id`, { id }))
        .toMatchObject({ status: "running" });
    }

    finishAll();
    await expect(waitForActiveJobs(5000)).resolves.toBe(true);
    for (const id of [a, b]) {
      expect(await sqlGet<{ status: string; locked_by: string | null }>(`SELECT status, locked_by FROM jobs WHERE id = @id`, { id }))
        .toEqual({ status: "completed", locked_by: null });
    }
  });

  it("starts builds for projects in different workspaces before either finishes", async () => {
    const { handler, finishAll } = registerDeferredKnowledgeHandler();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const a = await enqueueKnowledgeBuild({ workspaceId, orgUrl: organizationUrl, projectId: uniqueTestId("proj_pk_ws1") });
    const b = await enqueueKnowledgeBuild({ workspaceId: siblingWorkspaceId, orgUrl: siblingOrganizationUrl, projectId: uniqueTestId("proj_pk_ws2") });

    await expect(dispatchReadyKnowledgeJobs()).resolves.toBe(2);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const id of [a, b]) {
      expect(await sqlGet<{ status: string }>(`SELECT status FROM jobs WHERE id = @id`, { id }))
        .toMatchObject({ status: "running" });
    }

    finishAll();
    await expect(waitForActiveJobs(5000)).resolves.toBe(true);
    for (const id of [a, b]) {
      expect(await sqlGet<{ status: string }>(`SELECT status FROM jobs WHERE id = @id`, { id }))
        .toMatchObject({ status: "completed" });
    }
  });

  it("keeps one active build per project while siblings run: duplicates dedupe, not parallelize", async () => {
    const { handler, finishAll } = registerDeferredKnowledgeHandler();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const projectId = uniqueTestId("proj_pk_dup");
    const a = await enqueueKnowledgeBuild({ workspaceId, orgUrl: organizationUrl, projectId });

    await expect(dispatchReadyKnowledgeJobs()).resolves.toBe(1);
    expect(await sqlGet<{ status: string }>(`SELECT status FROM jobs WHERE id = @id`, { id: a }))
      .toMatchObject({ status: "running" });

    // A duplicate enqueue while the build runs is absorbed by the dedupe slot,
    // and the dispatcher finds nothing new to start.
    await expect(enqueueJob({
      jobType: PROJECT_KNOWLEDGE_JOB,
      workspaceId,
      projectId,
      dedupeKey: `project_knowledge:${projectId}`,
    })).resolves.toBeNull();
    await expect(dispatchReadyKnowledgeJobs()).resolves.toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);

    finishAll();
    await expect(waitForActiveJobs(5000)).resolves.toBe(true);
  });
});
