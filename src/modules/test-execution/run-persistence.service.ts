import "server-only";

import { z } from "zod";

import { NaturalPlanSchema } from "./action-schema";
import type { ExecutionOutcome, RunOutcome } from "./run-state";
import { decryptSecret } from "@/modules/security/encryption.service";
import {
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";

/**
 * Worker-side persistence for test execution runs. Every mutating statement
 * is fenced by the owning job (`runs.job_id`) so a stale or reclaimed worker
 * can never append results — the same guarantee the jobs table gets from
 * locked_by, extended to the run chain.
 */

export const EnvConfigSchema = z.object({
  initialUrl: z.string().min(1),
  allowedOrigin: z.string().min(1),
  viewportWidth: z.number().int().min(320).max(3840).default(1280),
  viewportHeight: z.number().int().min(320).max(3840).default(720),
  headless: z.boolean().default(true),
  defaultTimeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  navigationTimeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
  evidenceLevel: z.enum(["minimal", "on_failure", "all_steps"]).default("on_failure"),
  loginPlan: NaturalPlanSchema.nullable().default(null),
  loginMode: z.enum(["session", "fresh"]).default("session"),
  loggedInText: z.string().default(""),
  executionNotes: z.string().default(""),
  users: z
    .array(
      z.object({
        handle: z.string(),
        username: z.string(),
        passwordSecretName: z.string().nullable().default(null),
        notes: z.string().default(""),
      }),
    )
    .default([]),
});
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

export type RunExecutionBundle = {
  run: {
    id: string;
    workspaceId: string;
    projectId: string;
    azureProjectId: string;
    environmentProfileId: string | null;
    status: string;
    jobId: string | null;
    envConfig: EnvConfig;
  };
  secrets: Map<string, string>;
  cases: {
    id: string;
    orderIndex: number;
    title: string;
    status: string;
    compiledPlanJson: unknown;
  }[];
  steps: Map<string, { id: string; orderIndex: number; status: string }[]>;
};

type RunRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  azure_project_id: string;
  environment_profile_id: string | null;
  status: string;
  job_id: string | null;
  env_config_json: unknown;
};

export async function loadRunForExecution(runId: string): Promise<RunExecutionBundle | null> {
  const row = await sqlGet<RunRow>(
    `SELECT id, workspace_id, project_id, azure_project_id, environment_profile_id, status, job_id, env_config_json
     FROM test_execution_runs WHERE id = @runId`,
    { runId },
  );
  if (!row) return null;

  const envParsed = EnvConfigSchema.safeParse(row.env_config_json);
  if (!envParsed.success) {
    throw new Error(`Run ${runId} has an invalid frozen environment config.`);
  }

  const secretRows = await sqlAll<{
    secret_name: string;
    encrypted_secret: string;
    encryption_iv: string;
    encryption_tag: string;
    key_version: number;
  }>(
    `SELECT secret_name, encrypted_secret, encryption_iv, encryption_tag, key_version
     FROM test_execution_run_secrets WHERE run_id = @runId`,
    { runId },
  );
  const secrets = new Map<string, string>();
  for (const secret of secretRows) {
    secrets.set(
      secret.secret_name,
      decryptSecret({
        ciphertext: secret.encrypted_secret,
        iv: secret.encryption_iv,
        tag: secret.encryption_tag,
        keyVersion: secret.key_version,
      }),
    );
  }

  const caseRows = await sqlAll<{
    id: string;
    order_index: number;
    title: string;
    status: string;
    compiled_plan_json: unknown;
  }>(
    `SELECT id, order_index, title, status, compiled_plan_json
     FROM test_execution_case_runs WHERE run_id = @runId ORDER BY order_index ASC`,
    { runId },
  );

  const stepRows = await sqlAll<{ id: string; case_run_id: string; order_index: number; status: string }>(
    `SELECT id, case_run_id, order_index, status
     FROM test_execution_step_runs WHERE run_id = @runId ORDER BY order_index ASC`,
    { runId },
  );
  const steps = new Map<string, { id: string; orderIndex: number; status: string }[]>();
  for (const step of stepRows) {
    const list = steps.get(step.case_run_id) ?? [];
    list.push({ id: step.id, orderIndex: step.order_index, status: step.status });
    steps.set(step.case_run_id, list);
  }

  return {
    run: {
      id: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      azureProjectId: row.azure_project_id,
      environmentProfileId: row.environment_profile_id,
      status: row.status,
      jobId: row.job_id,
      envConfig: envParsed.data,
    },
    secrets,
    cases: caseRows.map((caseRow) => ({
      id: caseRow.id,
      orderIndex: caseRow.order_index,
      title: caseRow.title,
      status: caseRow.status,
      compiledPlanJson: caseRow.compiled_plan_json,
    })),
    steps,
  };
}

/** Claim the run for this job: queued → running (idempotent on re-claim by the same job). */
export async function markRunRunning(runId: string, jobId: string): Promise<boolean> {
  const updated = await sqlRun(
    `UPDATE test_execution_runs
     SET status = 'running', job_id = @jobId, started_at = COALESCE(started_at, @now), updated_at = @now
     WHERE id = @runId AND (status = 'queued' OR (status = 'running' AND job_id = @jobId))`,
    { runId, jobId, now: nowIso() },
  );
  return updated > 0;
}

const RUN_FENCE = `EXISTS (
  SELECT 1 FROM test_execution_runs r
  WHERE r.id = @runId AND r.status = 'running' AND r.job_id = @jobId
)`;

export async function markCaseRunning(runId: string, jobId: string, caseRunId: string): Promise<boolean> {
  const updated = await sqlRun(
    `UPDATE test_execution_case_runs
     SET status = 'running', started_at = COALESCE(started_at, @now), updated_at = @now
     WHERE id = @caseRunId AND run_id = @runId AND status = 'pending' AND ${RUN_FENCE}`,
    { runId, jobId, caseRunId, now: nowIso() },
  );
  return updated > 0;
}

export async function finalizeCase(
  runId: string,
  jobId: string,
  caseRunId: string,
  outcome: ExecutionOutcome,
  errorMessage?: string,
): Promise<void> {
  await sqlRun(
    `UPDATE test_execution_case_runs
     SET status = 'completed', outcome = @outcome, error_message = @errorMessage,
         finished_at = @now, updated_at = @now
     WHERE id = @caseRunId AND run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    { runId, jobId, caseRunId, outcome, errorMessage: errorMessage ?? null, now: nowIso() },
  );
}

export async function markStepRunning(runId: string, jobId: string, stepRunId: string): Promise<void> {
  await sqlRun(
    `UPDATE test_execution_step_runs
     SET status = 'running', started_at = COALESCE(started_at, @now), updated_at = @now
     WHERE id = @stepRunId AND run_id = @runId AND status = 'pending' AND ${RUN_FENCE}`,
    { runId, jobId, stepRunId, now: nowIso() },
  );
}

export async function finalizeStep(
  runId: string,
  jobId: string,
  stepRunId: string,
  outcome: ExecutionOutcome,
  observation: Record<string, unknown>,
  errorMessage?: string,
): Promise<void> {
  await sqlRun(
    `UPDATE test_execution_step_runs
     SET status = 'completed', outcome = @outcome, observation_json = @observationJson::jsonb,
         error_message = @errorMessage, finished_at = @now, updated_at = @now
     WHERE id = @stepRunId AND run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    {
      runId,
      jobId,
      stepRunId,
      outcome,
      observationJson: JSON.stringify(observation),
      errorMessage: errorMessage ?? null,
      now: nowIso(),
    },
  );
}

/** Steps of a case that never ran: pending → completed/not_run (or canceled). */
export async function finalizeRemainingSteps(
  runId: string,
  jobId: string,
  caseRunId: string,
  outcome: Extract<ExecutionOutcome, "not_run" | "canceled" | "infrastructure_error">,
): Promise<void> {
  await sqlRun(
    `UPDATE test_execution_step_runs
     SET status = 'completed', outcome = @outcome, finished_at = @now, updated_at = @now
     WHERE case_run_id = @caseRunId AND run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    { runId, jobId, caseRunId, outcome, now: nowIso() },
  );
}

/** Cases that never started: pending → completed with the given outcome. */
export async function finalizePendingCases(
  runId: string,
  jobId: string,
  outcome: Extract<ExecutionOutcome, "not_run" | "blocked_prerequisite" | "canceled">,
): Promise<void> {
  await sqlRun(
    `UPDATE test_execution_case_runs
     SET status = 'completed', outcome = @outcome, finished_at = @now, updated_at = @now
     WHERE run_id = @runId AND status = 'pending' AND ${RUN_FENCE}`,
    { runId, jobId, outcome, now: nowIso() },
  );
  await sqlRun(
    `UPDATE test_execution_step_runs s
     SET status = 'completed', outcome = 'not_run', finished_at = @now, updated_at = @now
     WHERE s.run_id = @runId AND s.status <> 'completed' AND ${RUN_FENCE}
       AND EXISTS (
         SELECT 1 FROM test_execution_case_runs c
         WHERE c.id = s.case_run_id AND c.outcome IN ('not_run', 'blocked_prerequisite', 'canceled')
       )`,
    { runId, jobId, now: nowIso() },
  );
}

export async function finalizeRun(
  runId: string,
  jobId: string,
  status: "completed" | "canceled" | "error",
  outcome: RunOutcome,
  summary: Record<string, unknown>,
  errorMessage?: string,
): Promise<boolean> {
  const updated = await sqlRun(
    `UPDATE test_execution_runs
     SET status = @status, outcome = @outcome, summary_json = @summaryJson::jsonb,
         error_message = @errorMessage, finished_at = @now, updated_at = @now
     WHERE id = @runId AND status = 'running' AND job_id = @jobId`,
    {
      runId,
      jobId,
      status,
      outcome,
      summaryJson: JSON.stringify(summary),
      errorMessage: errorMessage ?? null,
      now: nowIso(),
    },
  );
  return updated > 0;
}

/** Terminal case outcomes for the run rollup, in execution order. */
export async function listCaseOutcomes(runId: string): Promise<ExecutionOutcome[]> {
  const rows = await sqlAll<{ outcome: ExecutionOutcome | null }>(
    `SELECT outcome FROM test_execution_case_runs WHERE run_id = @runId ORDER BY order_index ASC`,
    { runId },
  );
  return rows.map((row) => row.outcome ?? "not_run");
}

/** User cancellation: in-flight rows → canceled, untouched rows → not_run, run → canceled. */
export async function finalizeRunForCancellation(runId: string, jobId: string): Promise<void> {
  const now = nowIso();
  await sqlRun(
    `UPDATE test_execution_step_runs
     SET status = 'completed', outcome = CASE WHEN status = 'running' THEN 'canceled' ELSE 'not_run' END,
         finished_at = @now, updated_at = @now
     WHERE run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    { runId, jobId, now },
  );
  await sqlRun(
    `UPDATE test_execution_case_runs
     SET status = 'completed', outcome = CASE WHEN status = 'running' THEN 'canceled' ELSE 'not_run' END,
         finished_at = @now, updated_at = @now
     WHERE run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    { runId, jobId, now },
  );
  await sqlRun(
    `UPDATE test_execution_runs
     SET status = 'canceled', outcome = 'canceled', finished_at = @now, updated_at = @now
     WHERE id = @runId AND status = 'running' AND job_id = @jobId`,
    { runId, jobId, now },
  );
}

/** Infrastructure failure: in-flight rows → infrastructure_error, untouched → not_run, run → error. */
export async function finalizeRunForInfrastructureError(
  runId: string,
  jobId: string,
  message: string,
): Promise<void> {
  const now = nowIso();
  await sqlRun(
    `UPDATE test_execution_step_runs
     SET status = 'completed',
         outcome = CASE WHEN status = 'running' THEN 'infrastructure_error' ELSE 'not_run' END,
         finished_at = @now, updated_at = @now
     WHERE run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    { runId, jobId, now },
  );
  await sqlRun(
    `UPDATE test_execution_case_runs
     SET status = 'completed',
         outcome = CASE WHEN status = 'running' THEN 'infrastructure_error' ELSE 'not_run' END,
         error_message = CASE WHEN status = 'running' THEN @message ELSE error_message END,
         finished_at = @now, updated_at = @now
     WHERE run_id = @runId AND status <> 'completed' AND ${RUN_FENCE}`,
    { runId, jobId, now, message },
  );
  await sqlRun(
    `UPDATE test_execution_runs
     SET status = 'error', outcome = 'infrastructure_error', error_message = @message,
         finished_at = @now, updated_at = @now
     WHERE id = @runId AND status = 'running' AND job_id = @jobId`,
    { runId, jobId, now, message },
  );
}

export async function insertArtifactRecord(input: {
  id: string;
  runId: string;
  jobId: string;
  workspaceId: string;
  projectId: string;
  azureProjectId: string;
  caseRunId: string | null;
  stepRunId: string | null;
  kind: "screenshot" | "console_log";
  storageKey: string;
  contentSha256: string;
  mimeType: string;
  byteSize: number;
  fileName: string;
  createdByWorker: string;
}): Promise<boolean> {
  const inserted = await sqlRun(
    `INSERT INTO test_execution_artifacts (
       id, run_id, workspace_id, project_id, azure_project_id, case_run_id, step_run_id,
       kind, storage_backend, storage_key, content_sha256, mime_type, byte_size, file_name,
       created_by_worker, created_at
     )
     SELECT @id, @runId, @workspaceId, @projectId, @azureProjectId, @caseRunId, @stepRunId,
            @kind, 'local_fs', @storageKey, @contentSha256, @mimeType, @byteSize, @fileName,
            @createdByWorker, @now
     WHERE ${RUN_FENCE}`,
    {
      id: input.id,
      runId: input.runId,
      jobId: input.jobId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      azureProjectId: input.azureProjectId,
      caseRunId: input.caseRunId,
      stepRunId: input.stepRunId,
      kind: input.kind,
      storageKey: input.storageKey,
      contentSha256: input.contentSha256,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      fileName: input.fileName,
      createdByWorker: input.createdByWorker,
      now: nowIso(),
    },
  );
  return inserted > 0;
}
