import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import type { ExecutionOutcome } from "./playwright-agent";
import { sanitizeExecutionError, sanitizeExecutionPayload } from "./execution-redaction";
import { insertRunTestData, runTestDataMeta, type PreparedTestDataEntry } from "./execution-test-data.service";
import type { ScreenshotPolicy } from "./screenshot-policy";
import { enqueueJob } from "@/modules/jobs/job-queue.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";

export type RunStatus = "queued" | "running" | "skipped" | ExecutionOutcome;

export type ExecutionRun = {
  id: string;
  name: string | null;
  workspaceId: string;
  projectId: string;
  azurePlanId: number | null;
  azureSuiteId: number | null;
  status: RunStatus;
  cancelRequested: boolean;
  totalCases: number;
  completedCases: number;
  baseUrl: string | null;
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

type RunRow = {
  id: string; name: string | null; workspace_id: string; project_id: string; azure_plan_id: number | null; azure_suite_id: number | null;
  status: RunStatus; cancel_requested: boolean; total_cases: number; completed_cases: number;
  base_url: string | null; execution_notes: string | null; screenshot_policy: ScreenshotPolicy;
  headless: boolean; viewport_width: number; viewport_height: number;
  error_message: string | null; created_at: string; updated_at: string;
};

const RUN_COLUMNS = `id, name, workspace_id, project_id, azure_plan_id, azure_suite_id, status, cancel_requested,
            total_cases, completed_cases, base_url, execution_notes, screenshot_policy,
            headless, viewport_width, viewport_height, error_message, created_at, updated_at`;

function mapRun(row: RunRow): ExecutionRun {
  return {
    id: row.id, name: row.name, workspaceId: row.workspace_id, projectId: row.project_id,
    azurePlanId: row.azure_plan_id, azureSuiteId: row.azure_suite_id,
    status: row.status, cancelRequested: row.cancel_requested,
    totalCases: row.total_cases, completedCases: row.completed_cases,
    baseUrl: row.base_url, executionNotes: row.execution_notes, screenshotPolicy: row.screenshot_policy,
    headless: row.headless, viewportWidth: row.viewport_width, viewportHeight: row.viewport_height,
    errorMessage: row.error_message, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export type ExecutionCaseInput = {
  testCaseId?: number | null;
  testPointId?: number | null;
  planId?: number | null;
  suiteId?: number | null;
  title: string;
  steps: Array<{ action: string; expectedResult?: string | null }>;
};

export async function createExecutionRun(input: {
  workspaceId: string; projectId: string; planId: number | null; suiteId: number | null; requestedByUserId: string;
  name: string | null;
  settings: { baseUrl: string; executionNotes: string | null; screenshotPolicy: ScreenshotPolicy; headless: boolean; viewportWidth: number; viewportHeight: number };
  testData: readonly PreparedTestDataEntry[];
  configSnapshot: Record<string, unknown>;
  job: { userId: string; scope: ProjectScope };
  cases: ExecutionCaseInput[];
}): Promise<{ runId: string; jobId: string }> {
  const runId = createId("pwrun");
  const now = nowIso();
  await withTransaction(async (client) => {
  await sqlRun(
    `INSERT INTO playwright_execution_runs (
       id, name, workspace_id, project_id, azure_plan_id, azure_suite_id, status,
       requested_by_user_id, total_cases, base_url, execution_notes, screenshot_policy,
       headless, viewport_width, viewport_height,
       config_snapshot_json, created_at, updated_at
     ) VALUES (@id, @name, @workspaceId, @projectId, @planId, @suiteId, 'queued',
       @userId, @totalCases, @baseUrl, @executionNotes, @screenshotPolicy,
       @headless, @viewportWidth, @viewportHeight, @snapshot::jsonb, @now, @now)`,
    { id: runId, name: input.name, workspaceId: input.workspaceId, projectId: input.projectId, planId: input.planId ?? null,
      suiteId: input.suiteId ?? null, userId: input.requestedByUserId, totalCases: input.cases.length,
      baseUrl: input.settings.baseUrl, executionNotes: input.settings.executionNotes,
      screenshotPolicy: input.settings.screenshotPolicy,
      headless: input.settings.headless, viewportWidth: input.settings.viewportWidth, viewportHeight: input.settings.viewportHeight,
      snapshot: JSON.stringify(input.configSnapshot), now },
    client,
  );
  await insertRunTestData(client, runId, input.testData, now);
  for (const testCase of input.cases) {
    const caseId = createId("pwcase");
    await sqlRun(
      `INSERT INTO playwright_execution_cases (
         id, run_id, azure_test_case_id, azure_test_point_id, azure_plan_id, azure_suite_id, title, status, created_at, updated_at
       ) VALUES (@id, @runId, @testCaseId, @testPointId, @planId, @suiteId, @title, 'queued', @now, @now)`,
      { id: caseId, runId, testCaseId: testCase.testCaseId ?? null, testPointId: testCase.testPointId ?? null,
        planId: testCase.planId ?? null, suiteId: testCase.suiteId ?? null, title: testCase.title, now }, client,
    );
    for (const [index, step] of testCase.steps.entries()) {
      await sqlRun(
        `INSERT INTO playwright_execution_steps (
           id, case_id, step_index, action, expected_result, status, created_at, updated_at
         ) VALUES (@id, @caseId, @stepIndex, @action, @expected, 'queued', @now, @now)`,
        { id: createId("pwstep"), caseId, stepIndex: index, action: step.action, expected: step.expectedResult ?? null, now }, client,
      );
    }
  }
  const jobId = await enqueueJob({
    jobType: "playwright_mcp_execution", workspaceId: input.workspaceId, projectId: input.projectId,
    createdByUserId: input.job.userId, dedupeKey: runId, maxAttempts: 1,
    payload: { runId, userId: input.job.userId, scope: input.job.scope },
  }, client);
  if (!jobId) throw new Error("Could not atomically enqueue the Playwright MCP execution job.");
  await sqlRun(`UPDATE playwright_execution_runs SET job_id = @jobId, updated_at = @now WHERE id = @runId`, { runId, jobId, now }, client);
  });
  const jobId = await executionRunJobId(runId, input.workspaceId, input.projectId);
  if (!jobId) throw new Error("Playwright MCP execution job was not attached.");
  return { runId, jobId };
}

export async function executionRunJobId(id: string, workspaceId: string, projectId: string): Promise<string | null> {
  const row = await sqlGet<{ job_id: string | null }>(`SELECT job_id FROM playwright_execution_runs WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId`, { id, workspaceId, projectId });
  return row?.job_id ?? null;
}

export async function executionConfigSnapshot(runId: string): Promise<Record<string, unknown> | null> {
  const row = await sqlGet<{ config_snapshot_json: Record<string, unknown> }>(`SELECT config_snapshot_json FROM playwright_execution_runs WHERE id = @runId`, { runId });
  return row?.config_snapshot_json ?? null;
}

export type ExecutionRunSettings = {
  baseUrl: string | null;
  executionNotes: string | null;
  screenshotPolicy: ScreenshotPolicy;
  headless: boolean;
  viewportWidth: number;
  viewportHeight: number;
};

export async function executionRunSettings(runId: string): Promise<ExecutionRunSettings | null> {
  const row = await sqlGet<{ base_url: string | null; execution_notes: string | null; screenshot_policy: ScreenshotPolicy; headless: boolean; viewport_width: number; viewport_height: number }>(
    `SELECT base_url, execution_notes, screenshot_policy, headless, viewport_width, viewport_height FROM playwright_execution_runs WHERE id = @runId`, { runId },
  );
  return row ? {
    baseUrl: row.base_url, executionNotes: row.execution_notes, screenshotPolicy: row.screenshot_policy,
    headless: row.headless, viewportWidth: row.viewport_width, viewportHeight: row.viewport_height,
  } : null;
}

export type ExecutionPublicationSummary = {
  status: "running" | "completed" | "partial" | "failed";
  published: number;
  total: number;
  finishedAt: string | null;
};

export async function getExecutionPublication(runId: string): Promise<ExecutionPublicationSummary | null> {
  const row = await sqlGet<{ status: ExecutionPublicationSummary["status"]; result_json: unknown; finished_at: string | null }>(
    `SELECT status, result_json, finished_at FROM playwright_execution_publications WHERE run_id = @runId`, { runId },
  );
  if (!row) return null;
  const results = Array.isArray(row.result_json) ? row.result_json as Array<{ success?: boolean }> : [];
  return {
    status: row.status,
    published: results.filter((result) => result.success === true).length,
    total: results.length,
    finishedAt: row.finished_at,
  };
}

export async function getExecutionRun(id: string, workspaceId: string, projectId: string): Promise<ExecutionRun | null> {
  const row = await sqlGet<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM playwright_execution_runs
      WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId`,
    { id, workspaceId, projectId },
  );
  return row ? mapRun(row) : null;
}

export async function getExecutionRunDetails(id: string, workspaceId: string, projectId: string) {
  const run = await getExecutionRun(id, workspaceId, projectId);
  if (!run) return null;
  const caseRows = await sqlAll<{ id: string; azure_test_case_id: number | null; azure_test_point_id: number | null; azure_plan_id: number | null; azure_suite_id: number | null; title: string; status: RunStatus; error_message: string | null }>(
    `SELECT id, azure_test_case_id, azure_test_point_id, azure_plan_id, azure_suite_id, title, status, error_message
       FROM playwright_execution_cases WHERE run_id = @id ORDER BY created_at`, { id },
  );
  const cases = [];
  for (const testCase of caseRows) {
    const steps = await sqlAll<{ id: string; step_index: number; action: string; expected_result: string | null; status: RunStatus; tool_name: string | null; error_message: string | null }>(
      `SELECT id, step_index, action, expected_result, status, tool_name, error_message
         FROM playwright_execution_steps WHERE case_id = @caseId ORDER BY step_index`, { caseId: testCase.id },
    );
    cases.push({
      id: testCase.id, azureTestCaseId: testCase.azure_test_case_id, azureTestPointId: testCase.azure_test_point_id,
      azurePlanId: testCase.azure_plan_id, azureSuiteId: testCase.azure_suite_id,
      title: testCase.title, status: testCase.status, errorMessage: testCase.error_message,
      steps: steps.map((step) => ({ id: step.id, index: step.step_index, action: step.action, expectedResult: step.expected_result, status: step.status, toolName: step.tool_name, errorMessage: step.error_message })),
    });
  }
  const artifacts = await sqlAll<{ id: string; case_id: string | null; step_id: string | null; kind: string; mime_type: string; byte_size: number }>(
    `SELECT id, case_id, step_id, kind, mime_type, byte_size FROM playwright_execution_artifacts WHERE run_id = @id ORDER BY created_at`, { id },
  );
  const [testData, publication] = await Promise.all([runTestDataMeta(id), getExecutionPublication(id)]);
  return {
    ...run, cases, testData, publication,
    artifacts: artifacts.map((artifact) => ({ id: artifact.id, caseId: artifact.case_id, stepId: artifact.step_id, kind: artifact.kind, mimeType: artifact.mime_type, byteSize: artifact.byte_size })),
  };
}

export async function listExecutionRuns(workspaceId: string, projectId: string, limit = 50): Promise<ExecutionRun[]> {
  const rows = await sqlAll<RunRow>(
    `SELECT ${RUN_COLUMNS}
       FROM playwright_execution_runs WHERE workspace_id = @workspaceId AND project_id = @projectId
      ORDER BY created_at DESC LIMIT @limit`,
    { workspaceId, projectId, limit: Math.min(Math.max(limit, 1), 100) },
  );
  return rows.map(mapRun);
}

export async function requestExecutionCancellation(id: string, workspaceId: string, projectId: string): Promise<boolean> {
  return Boolean(await sqlRun(
    `UPDATE playwright_execution_runs SET cancel_requested = true, updated_at = @now
      WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId
        AND status IN ('queued', 'running')`,
    { id, workspaceId, projectId, now: nowIso() },
  ));
}

export type StoredCase = { id: string; azureTestCaseId: number | null; azureTestPointId: number | null; azurePlanId: number | null; azureSuiteId: number | null; title: string; status: RunStatus };
export type StoredStep = { id: string; stepIndex: number; action: string; expectedResult: string | null; status: RunStatus };

export async function casesForRun(runId: string): Promise<StoredCase[]> {
  const rows = await sqlAll<{ id: string; azure_test_case_id: number | null; azure_test_point_id: number | null; azure_plan_id: number | null; azure_suite_id: number | null; title: string; status: RunStatus }>(
    `SELECT id, azure_test_case_id, azure_test_point_id, azure_plan_id, azure_suite_id, title, status FROM playwright_execution_cases WHERE run_id = @runId ORDER BY created_at`, { runId },
  );
  return rows.map((row) => ({ id: row.id, azureTestCaseId: row.azure_test_case_id, azureTestPointId: row.azure_test_point_id, azurePlanId: row.azure_plan_id, azureSuiteId: row.azure_suite_id, title: row.title, status: row.status }));
}

export async function stepsForCase(caseId: string): Promise<StoredStep[]> {
  const rows = await sqlAll<{ id: string; step_index: number; action: string; expected_result: string | null; status: RunStatus }>(
    `SELECT id, step_index, action, expected_result, status FROM playwright_execution_steps WHERE case_id = @caseId ORDER BY step_index`, { caseId },
  );
  return rows.map((row) => ({ id: row.id, stepIndex: row.step_index, action: row.action, expectedResult: row.expected_result, status: row.status }));
}

export async function markRunStarted(runId: string) {
  const now = nowIso();
  await sqlRun(`UPDATE playwright_execution_runs SET status = 'running', started_at = @now, updated_at = @now WHERE id = @runId`, { runId, now });
}

export async function markCaseStarted(caseId: string) {
  const now = nowIso();
  await sqlRun(`UPDATE playwright_execution_cases SET status = 'running', started_at = @now, updated_at = @now WHERE id = @caseId`, { caseId, now });
}

export async function markStepStarted(stepId: string) {
  const now = nowIso();
  await sqlRun(`UPDATE playwright_execution_steps SET status = 'running', updated_at = @now WHERE id = @stepId`, { stepId, now });
}

/**
 * Steps that never ran because their case ended early (failed step, base-URL
 * navigation failure, browser session failure) become 'skipped' — a terminal
 * status, so "Queued" never lingers on work that will not happen. Cancellation
 * keeps its own sweep in finishRun ('cancelled').
 */
export async function skipRemainingQueuedSteps(caseId: string) {
  const now = nowIso();
  await sqlRun(`UPDATE playwright_execution_steps SET status = 'skipped', updated_at = @now WHERE case_id = @caseId AND status = 'queued'`, { caseId, now });
}

export async function recordStepToolCall(stepId: string, toolName: string, args: Record<string, unknown>, result: unknown, secrets: readonly string[] = []) {
  await sqlRun(`UPDATE playwright_execution_steps SET status = 'running', tool_name = @toolName,
    tool_arguments_json = @args::jsonb, tool_result_json = @result::jsonb, updated_at = @now WHERE id = @stepId`,
  { stepId, toolName, args: JSON.stringify(sanitizeExecutionPayload(args, secrets)), result: JSON.stringify(sanitizeExecutionPayload(result ?? null, secrets)), now: nowIso() });
}

export async function finishStep(stepId: string, outcome: ExecutionOutcome, errorMessage?: string | null, secrets: readonly string[] = []) {
  await sqlRun(`UPDATE playwright_execution_steps SET status = @outcome, error_message = @error, updated_at = @now WHERE id = @stepId`,
    { stepId, outcome, error: errorMessage ? sanitizeExecutionError(errorMessage, secrets) : null, now: nowIso() });
}

export async function finishCase(caseId: string, outcome: ExecutionOutcome, errorMessage?: string | null, secrets: readonly string[] = []) {
  const now = nowIso();
  await sqlRun(`UPDATE playwright_execution_cases SET status = @outcome, error_message = @error, finished_at = @now, updated_at = @now WHERE id = @caseId`,
    { caseId, outcome, error: errorMessage ? sanitizeExecutionError(errorMessage, secrets) : null, now });
}

export async function incrementCompletedCases(runId: string) {
  await sqlRun(`UPDATE playwright_execution_runs SET completed_cases = completed_cases + 1, updated_at = @now WHERE id = @runId`, { runId, now: nowIso() });
}

export async function finishRun(runId: string, outcome: ExecutionOutcome, errorMessage?: string | null, secrets: readonly string[] = []) {
  const now = nowIso();
  if (outcome === "cancelled") {
    await sqlRun(`UPDATE playwright_execution_steps SET status = 'cancelled', error_message = 'Execution was cancelled.', updated_at = @now
      WHERE status = 'queued' AND case_id IN (SELECT id FROM playwright_execution_cases WHERE run_id = @runId)`, { runId, now });
    await sqlRun(`UPDATE playwright_execution_cases SET status = 'cancelled', error_message = 'Execution was cancelled.', finished_at = @now, updated_at = @now
      WHERE run_id = @runId AND status = 'queued'`, { runId, now });
  }
  await sqlRun(`UPDATE playwright_execution_runs SET status = @outcome, error_message = @error, finished_at = @now, updated_at = @now WHERE id = @runId`,
    { runId, outcome, error: errorMessage ? sanitizeExecutionError(errorMessage, secrets) : null, now });
}

export async function isRunCancellationRequested(runId: string): Promise<boolean> {
  const row = await sqlGet<{ cancel_requested: boolean }>(`SELECT cancel_requested FROM playwright_execution_runs WHERE id = @runId`, { runId });
  return row?.cancel_requested ?? true;
}

export type PublishableCase = {
  id: string;
  azureTestCaseId: number | null;
  azureTestPointId: number;
  azurePlanId: number;
  azureSuiteId: number;
  title: string;
  status: ExecutionOutcome;
  outcome: ExecutionOutcome;
};

export async function publishableCases(runId: string): Promise<PublishableCase[]> {
  const rows = await sqlAll<{ id: string; azure_test_case_id: number | null; azure_test_point_id: number; azure_plan_id: number; azure_suite_id: number; title: string; status: ExecutionOutcome }>(
    `SELECT id, azure_test_case_id, azure_test_point_id, azure_plan_id, azure_suite_id, title, status
       FROM playwright_execution_cases WHERE run_id = @runId
        AND azure_test_point_id IS NOT NULL AND azure_plan_id IS NOT NULL AND azure_suite_id IS NOT NULL
        AND status IN ('passed', 'failed', 'blocked', 'timeout', 'cancelled', 'error') ORDER BY created_at`, { runId },
  );
  return rows.map((row) => ({ id: row.id, azureTestCaseId: row.azure_test_case_id, azureTestPointId: row.azure_test_point_id, azurePlanId: row.azure_plan_id, azureSuiteId: row.azure_suite_id, title: row.title, status: row.status, outcome: row.status }));
}

type PublicationLease = { id: string; leaseToken: string };

export async function beginExecutionPublication(runId: string, userId: string): Promise<PublicationLease | null> {
  const id = createId("pwpub");
  const leaseToken = createId("pwlease");
  const inserted = await sqlGet<{ id: string }>(`INSERT INTO playwright_execution_publications
    (id, run_id, published_by_user_id, status, result_json, lease_token, created_at, updated_at)
    VALUES (@id, @runId, @userId, 'running', '[]'::jsonb, @leaseToken, @now, @now)
    ON CONFLICT (run_id) DO NOTHING RETURNING id`, { id, runId, userId, leaseToken, now: nowIso() });
  return inserted ? { id: inserted.id, leaseToken } : null;
}

export async function beginFailedExecutionPublicationRetry(runId: string): Promise<(PublicationLease & { prior: Array<{ testCaseId: number | null; testPointId: number | null; success: boolean; error?: string }> }) | null> {
  return withTransaction(async (client) => {
    const row = await sqlGet<{ id: string; status: string; result_json: unknown; updated_at: string }>(
      `SELECT id, status, result_json, updated_at FROM playwright_execution_publications WHERE run_id = @runId FOR UPDATE`, { runId }, client,
    );
    const now = nowIso();
    const staleRunning = row?.status === "running" && Date.parse(row.updated_at) <= Date.parse(now) - 30 * 60 * 1000;
    if (!row || (!staleRunning && !["partial", "failed"].includes(row.status))) return null;
    const prior = Array.isArray(row.result_json) ? row.result_json as Array<{ testCaseId: number | null; testPointId: number | null; success: boolean; error?: string }> : [];
    const leaseToken = createId("pwlease");
    await sqlRun(`UPDATE playwright_execution_publications
      SET status = 'running', lease_token = @leaseToken, finished_at = NULL, updated_at = @now
      WHERE id = @id`, { id: row.id, leaseToken, now }, client);
    return { id: row.id, leaseToken, prior };
  });
}

export async function recordExecutionPublicationResult(
  id: string,
  leaseToken: string,
  result: { testCaseId: number | null; testPointId: number | null; success: boolean; error?: string },
): Promise<boolean> {
  const now = nowIso();
  return (await sqlRun(`UPDATE playwright_execution_publications
    SET result_json = result_json || jsonb_build_array(@result::jsonb), updated_at = @now
    WHERE id = @id AND status = 'running' AND lease_token = @leaseToken`, { id, leaseToken, result: JSON.stringify(result), now })) > 0;
}

export async function finishExecutionPublication(input: {
  id: string; leaseToken: string; status: "completed" | "partial" | "failed"; result: unknown;
}) {
  const now = nowIso();
  await sqlRun(`UPDATE playwright_execution_publications SET status = @status, result_json = @result::jsonb, finished_at = @now, updated_at = @now
    WHERE id = @id AND status = 'running' AND lease_token = @leaseToken`, {
    id: input.id, leaseToken: input.leaseToken, status: input.status, result: JSON.stringify(input.result), now,
  });
}
