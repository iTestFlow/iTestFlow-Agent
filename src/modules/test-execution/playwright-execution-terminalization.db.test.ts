import { afterAll, beforeAll, expect, it } from "vitest";

import { requeueOwnedJobs, claimNextJob, enqueueJob } from "@/modules/jobs/job-queue.service";
import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";

const workspaceId = uniqueTestId("ws_pw_terminal");
const userId = uniqueTestId("user_pw_terminal");
const projectId = uniqueTestId("project_pw_terminal");
const orgUrl = "https://dev.azure.com/pw-terminal";

describeDb("Playwright execution job terminalization (DB-backed)", () => {
  beforeAll(async () => {
    await seedUser({ id: userId, email: `${userId}@example.test` });
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
    await resetDatabaseForTests();
  });

  it("terminalizes a run, case, and step when shutdown fails a single-attempt job", async () => {
    const jobId = await enqueueJob({
      jobType: "playwright_mcp_execution", workspaceId, projectId,
      createdByUserId: userId, maxAttempts: 1,
    });
    expect((await claimNextJob("pw-terminal-worker", ["playwright_mcp_execution"]))?.id).toBe(jobId);
    const runId = uniqueTestId("pwrun");
    const caseId = uniqueTestId("pwcase");
    const now = new Date().toISOString();
    await sqlRun(
      `INSERT INTO playwright_execution_runs (
         id, workspace_id, project_id, azure_plan_id, azure_suite_id, status,
         requested_by_user_id, job_id, created_at, updated_at
       ) VALUES (@runId, @workspaceId, @projectId, 1, 2, 'running', @userId, @jobId, @now, @now)`,
      { runId, workspaceId, projectId, userId, jobId, now },
    );
    await sqlRun(
      `INSERT INTO playwright_execution_cases (
         id, run_id, azure_test_case_id, azure_suite_id, title, status, created_at, updated_at
       ) VALUES (@caseId, @runId, 3, 2, 'Case', 'running', @now, @now)`,
      { caseId, runId, now },
    );
    await sqlRun(
      `INSERT INTO playwright_execution_steps (
         id, case_id, step_index, action, status, created_at, updated_at
       ) VALUES (@stepId, @caseId, 0, 'Open app', 'running', @now, @now)`,
      { stepId: uniqueTestId("pwstep"), caseId, now },
    );

    await expect(requeueOwnedJobs([jobId!], "pw-terminal-worker")).resolves.toBe(1);
    const state = await sqlGet<{ job_status: string; run_status: string; case_status: string; step_status: string }>(
      `SELECT job.status AS job_status, execution_run.status AS run_status,
              execution_case.status AS case_status, execution_step.status AS step_status
         FROM jobs AS job
         JOIN playwright_execution_runs AS execution_run ON execution_run.job_id = job.id
         JOIN playwright_execution_cases AS execution_case ON execution_case.run_id = execution_run.id
         JOIN playwright_execution_steps AS execution_step ON execution_step.case_id = execution_case.id
        WHERE job.id = @jobId`,
      { jobId },
    );
    expect(state).toEqual({ job_status: "failed", run_status: "error", case_status: "error", step_status: "error" });
  });
});
