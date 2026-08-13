import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { TEST_EXECUTION_RUN } from "@/modules/jobs/test-execution-jobs.service";
import type { JobStatus } from "@/modules/jobs/job-queue.service";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import {
  EnvConfigSchema,
  finalizeOrphanedRuns,
  markCaseRunning,
  markRunRunning,
  markStepRunning,
  startActionRun,
} from "./run-persistence.service";

/**
 * Orphan recovery: a worker that dies mid-run leaves its job terminal (browser
 * jobs are maxAttempts = 1, so the stale-lock reap always fails them) and its
 * run 'running' forever, which wedges the project's one-active-run slot. The
 * sweep must close such a run out exactly like an infrastructure failure —
 * in-flight mutations uncertain — and must not touch a run whose job still has
 * an owner.
 */

const workspaceId = uniqueTestId("ws_orph");
const projectId = uniqueTestId("proj_orph");
const userId = uniqueTestId("usr_orph");
const orgUrl = `https://dev.azure.com/${workspaceId}`;

const runEnv = EnvConfigSchema.parse({
  initialUrl: "https://app.example.com/",
  allowedOrigin: "https://app.example.com",
});

type RunRow = {
  status: string;
  outcome: string | null;
  error_message: string | null;
  finished_at: string | null;
  updated_at: string;
};

type ActionRow = { status: string; error_category: string | null; error_message: string | null };

type SeededRun = {
  runId: string;
  jobId: string;
  runningCaseId: string;
  pendingCaseId: string;
  runningStepId: string;
  pendingStepId: string;
  mutationActionId: string;
  readActionId: string;
};

async function insertQueuedRun(runId: string): Promise<void> {
  // Only one run per project may be active: retire whatever an earlier case left.
  await sqlRun(
    `UPDATE test_execution_runs
     SET status = 'completed', outcome = 'passed', finished_at = @now, updated_at = @now
     WHERE project_id = @projectId AND status IN ('queued', 'running')`,
    { projectId, now: nowIso() },
  );
  await sqlRun(
    `INSERT INTO test_execution_runs (
       id, workspace_id, project_id, azure_project_id, env_config_json,
       approved_by, approved_at, created_by, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @projectId, @envConfig::jsonb,
       @userId, @now, @userId, @now, @now
     )`,
    {
      id: runId,
      workspaceId,
      projectId,
      envConfig: JSON.stringify(runEnv),
      userId,
      now: nowIso(),
    },
  );
}

/**
 * A mid-flight run exactly as a killed worker leaves it: one running case with
 * a running step carrying an in-flight mutation and read action, plus untouched
 * pending rows, owned by a job in `jobStatus`.
 */
async function seedRunOwnedByJob(jobStatus: JobStatus): Promise<SeededRun> {
  const jobId = uniqueTestId("job_orph");
  const runId = uniqueTestId("run_orph");
  const now = nowIso();
  const isTerminal = jobStatus !== "pending" && jobStatus !== "running";
  await sqlRun(
    `INSERT INTO jobs (
       id, workspace_id, project_id, job_type, payload_json, status, priority,
       attempts, max_attempts, run_after, started_at, finished_at, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @jobType, @payload, @status, 100,
       1, 1, @now, @now, @finishedAt, @now, @now
     )`,
    {
      id: jobId,
      workspaceId,
      projectId,
      jobType: TEST_EXECUTION_RUN,
      payload: JSON.stringify({ runId, projectId }),
      status: jobStatus,
      finishedAt: isTerminal ? now : null,
      now,
    },
  );

  await insertQueuedRun(runId);
  expect(await markRunRunning(runId, jobId)).toBe(true);

  const runningCaseId = uniqueTestId("case_orph");
  const pendingCaseId = uniqueTestId("case_orph");
  for (const [orderIndex, caseId] of [runningCaseId, pendingCaseId].entries()) {
    await sqlRun(
      `INSERT INTO test_execution_case_runs (
         id, run_id, workspace_id, project_id, azure_project_id, order_index,
         source_kind, title, compiled_plan_json, compile_source, created_at, updated_at
       ) VALUES (@id, @runId, @workspaceId, @projectId, @projectId, @orderIndex,
         'manual', @title, @plan::jsonb, 'natural_text', @now, @now)`,
      {
        id: caseId,
        runId,
        workspaceId,
        projectId,
        orderIndex,
        title: `Case ${orderIndex}`,
        plan: JSON.stringify({ schemaVersion: "v2-natural", steps: [] }),
        now: nowIso(),
      },
    );
  }

  const runningStepId = uniqueTestId("step_orph");
  const pendingStepId = uniqueTestId("step_orph");
  for (const [orderIndex, stepId] of [runningStepId, pendingStepId].entries()) {
    await sqlRun(
      `INSERT INTO test_execution_step_runs (
         id, case_run_id, run_id, workspace_id, project_id, azure_project_id,
         order_index, action_json, created_at, updated_at
       ) VALUES (@id, @caseId, @runId, @workspaceId, @projectId, @projectId, @orderIndex, @action::jsonb, @now, @now)`,
      {
        id: stepId,
        caseId: runningCaseId,
        runId,
        workspaceId,
        projectId,
        orderIndex,
        action: JSON.stringify({ instruction: `Step ${orderIndex}`, expectedResult: "" }),
        now: nowIso(),
      },
    );
  }

  expect(await markCaseRunning(runId, jobId, runningCaseId)).toBe(true);
  await markStepRunning(runId, jobId, runningStepId);

  const actionInput = {
    runId,
    jobId,
    workspaceId,
    projectId,
    azureProjectId: projectId,
    caseRunId: runningCaseId,
    stepRunId: runningStepId,
  };
  const mutationActionId = await startActionRun({
    ...actionInput,
    orderIndex: 0,
    layer: "api",
    actionType: "api.request",
    safetyClass: "mutation",
    request: { method: "POST", path: "/orders" },
  });
  const readActionId = await startActionRun({
    ...actionInput,
    orderIndex: 1,
    layer: "db",
    actionType: "db.query",
    safetyClass: "read",
    request: { sql: "SELECT 1" },
  });
  expect(mutationActionId).not.toBeNull();
  expect(readActionId).not.toBeNull();

  return {
    runId,
    jobId,
    runningCaseId,
    pendingCaseId,
    runningStepId,
    pendingStepId,
    mutationActionId: mutationActionId as string,
    readActionId: readActionId as string,
  };
}

function loadRun(runId: string) {
  return sqlGet<RunRow>(
    `SELECT status, outcome, error_message, finished_at, updated_at
     FROM test_execution_runs WHERE id = @runId`,
    { runId },
  );
}

function loadAction(actionRunId: string) {
  return sqlGet<ActionRow>(
    `SELECT status, error_category, error_message
     FROM test_execution_action_runs WHERE id = @actionRunId`,
    { actionRunId },
  );
}

function loadRowStates(table: "test_execution_case_runs" | "test_execution_step_runs", runId: string) {
  return sqlAll<{ id: string; status: string; outcome: string | null }>(
    `SELECT id, status, outcome FROM ${table} WHERE run_id = @runId ORDER BY order_index`,
    { runId },
  );
}

describeDb("orphaned test execution runs", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    // Cases, steps, actions cascade from their run.
    await sqlRun(`DELETE FROM test_execution_runs WHERE workspace_id = @workspaceId`, { workspaceId });
    await sqlRun(`DELETE FROM jobs WHERE workspace_id = @workspaceId`, { workspaceId });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("finalizes a running run whose job is terminally failed", async () => {
    const seeded = await seedRunOwnedByJob("failed");

    expect((await finalizeOrphanedRuns()).length).toBeGreaterThanOrEqual(1);

    const run = await loadRun(seeded.runId);
    expect(run?.status).toBe("error");
    expect(run?.outcome).toBe("infrastructure_error");
    expect(run?.finished_at).not.toBeNull();
    expect(run?.error_message).toContain("stopped before it finished");
  });

  it("leaves an in-flight mutation uncertain and fails the in-flight read", async () => {
    const seeded = await seedRunOwnedByJob("failed");

    await finalizeOrphanedRuns();

    expect(await loadAction(seeded.mutationActionId)).toMatchObject({
      status: "uncertain",
      error_category: "uncertain_side_effect",
    });
    expect(await loadAction(seeded.readActionId)).toMatchObject({
      status: "failed",
      error_category: "infrastructure",
    });
  });

  it("rolls the outcome up through steps and cases", async () => {
    const seeded = await seedRunOwnedByJob("completed");

    await finalizeOrphanedRuns();

    expect(await loadRowStates("test_execution_step_runs", seeded.runId)).toEqual([
      { id: seeded.runningStepId, status: "completed", outcome: "infrastructure_error" },
      { id: seeded.pendingStepId, status: "completed", outcome: "not_run" },
    ]);
    expect(await loadRowStates("test_execution_case_runs", seeded.runId)).toEqual([
      { id: seeded.runningCaseId, status: "completed", outcome: "infrastructure_error" },
      { id: seeded.pendingCaseId, status: "completed", outcome: "not_run" },
    ]);
  });

  it("leaves a run alone while its job is still running", async () => {
    const seeded = await seedRunOwnedByJob("running");

    await finalizeOrphanedRuns();

    expect(await loadRun(seeded.runId)).toMatchObject({ status: "running", outcome: null, finished_at: null });
    expect(await loadAction(seeded.mutationActionId)).toMatchObject({ status: "running" });
  });

  it("leaves a run alone while its job is still pending", async () => {
    // The shutdown requeue puts a running run's job back to 'pending'; the
    // reclaiming worker resumes it, so nothing may finalize it here.
    const seeded = await seedRunOwnedByJob("pending");

    await finalizeOrphanedRuns();

    expect(await loadRun(seeded.runId)).toMatchObject({ status: "running", outcome: null, finished_at: null });
    expect(await loadAction(seeded.mutationActionId)).toMatchObject({ status: "running" });
  });

  it("is idempotent: a second sweep changes nothing", async () => {
    const seeded = await seedRunOwnedByJob("cancelled");

    expect((await finalizeOrphanedRuns()).length).toBeGreaterThanOrEqual(1);
    const afterFirst = await loadRun(seeded.runId);

    expect(await finalizeOrphanedRuns()).toEqual([]);
    expect(await loadRun(seeded.runId)).toEqual(afterFirst);
    expect(await loadAction(seeded.mutationActionId)).toMatchObject({ status: "uncertain" });
  });

  it("frees the project's active-run slot for a new run", async () => {
    const seeded = await seedRunOwnedByJob("failed");
    await finalizeOrphanedRuns();
    expect((await loadRun(seeded.runId))?.status).toBe("error");

    // uq_test_execution_runs_active_project would reject this insert while the
    // orphan was still counted as active.
    const nextRunId = uniqueTestId("run_orph");
    await sqlRun(
      `INSERT INTO test_execution_runs (
         id, workspace_id, project_id, azure_project_id, env_config_json,
         approved_by, approved_at, created_by, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, @envConfig::jsonb,
         @userId, @now, @userId, @now, @now
       )`,
      {
        id: nextRunId,
        workspaceId,
        projectId,
        envConfig: JSON.stringify(runEnv),
        userId,
        now: nowIso(),
      },
    );

    expect((await loadRun(nextRunId))?.status).toBe("queued");
  });
});
