import "server-only";

import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { encryptSecret, maskSecret } from "@/modules/security/encryption.service";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { enqueueTestExecutionRunJob } from "@/modules/jobs/test-execution-jobs.service";
import {
  createId,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";

import { NATURAL_PLAN_SCHEMA_VERSION, type NaturalPlan } from "./action-schema";
import { validateNaturalPlan, type PlanFinding } from "./natural-plan";
import { buildStorySnapshot, buildTestCaseSnapshot, type SourceSnapshotInput } from "./snapshot.service";
import type { EnvConfig } from "./run-persistence.service";
import type { RunCaseInput, SecretInput } from "./schemas/test-execution.schemas";

/**
 * Run creation and read models. Creation freezes everything: env config (with
 * login plan), a per-run copy of secrets, Azure source snapshots (fetched
 * BEFORE the insert transaction — no network inside a transaction), and the
 * approved compiled plans. Enqueue happens after commit; if it fails the run
 * is finalized as error so the one-active-run slot is never wedged.
 */

export class ActiveRunConflictError extends Error {
  constructor(readonly activeRunId: string | null) {
    super("Another run is already queued or running for this project.");
    this.name = "ActiveRunConflictError";
  }
}

export class RunPlanValidationError extends Error {
  constructor(readonly findings: PlanFinding[]) {
    super(findings.find((f) => f.severity === "error")?.message ?? "The execution plan is not valid.");
    this.name = "RunPlanValidationError";
  }
}

export type CreateRunInput = {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  adapter: AzureDevOpsAdapter;
  environment: {
    profileId: string | null;
    config: EnvConfig;
    /** One-time secrets (empty when a profile is used). */
    oneTimeSecrets: SecretInput[];
  };
  story: { workItemId: string; title: string } | null;
  cases: RunCaseInput[];
};

export async function createRunWithSnapshots(input: CreateRunInput): Promise<{ runId: string; jobId: string | null }> {
  // 1. Validate every plan before touching the database or Azure. Structural
  //    problems block; unknown-secret references are warnings surfaced in the
  //    review step (the agent would hit them as blocked at run time).
  const secretNames = await collectAvailableSecretNames(input);
  const allFindings: PlanFinding[] = [];
  for (const caseInput of input.cases) {
    const validation = validateNaturalPlan(caseInput.plan, { availableSecretNames: secretNames });
    if (!validation.ok) allFindings.push(...validation.findings);
  }
  if (allFindings.some((finding) => finding.severity === "error")) {
    throw new RunPlanValidationError(allFindings);
  }

  // 2. Azure snapshots — network calls stay outside the transaction.
  const snapshots: SourceSnapshotInput[] = [];
  let storyTitle = input.story?.title ?? "";
  if (input.story) {
    const story = await input.adapter.fetchWorkItemById({
      projectId: input.scope.azureProjectId,
      workItemId: input.story.workItemId,
    });
    if (story) {
      snapshots.push(buildStorySnapshot(story));
      storyTitle = story.title;
    }
    const azureCaseIds = new Set(
      input.cases.filter((c) => c.sourceKind === "azure_test_case" && c.azureTestCaseId).map((c) => c.azureTestCaseId as string),
    );
    if (azureCaseIds.size > 0) {
      const linked = await input.adapter.fetchLinkedTestCases({
        projectId: input.scope.azureProjectId,
        userStoryId: input.story.workItemId,
      });
      for (const testCase of linked) {
        const azureId = testCase.azureTestCaseId ?? testCase.id;
        if (azureCaseIds.has(azureId)) snapshots.push(buildTestCaseSnapshot(testCase));
      }
    }
  }
  // 3. Freeze rows atomically.
  const runId = createId("trun");
  const now = nowIso();
  try {
    await withTransaction(async (client) => {
      await sqlRun(
        `INSERT INTO test_execution_runs (
           id, workspace_id, project_id, azure_project_id, environment_profile_id, env_config_json,
           story_work_item_id, story_title, plan_schema_version,
           approved_by, approved_at, created_by, created_at, updated_at
         ) VALUES (
           @id, @workspaceId, @projectId, @azureProjectId, @environmentProfileId, @envConfigJson::jsonb,
           @storyWorkItemId, @storyTitle, @planSchemaVersion,
           @actor, @now, @actor, @now, @now
         )`,
        {
          id: runId,
          workspaceId: input.workspaceId,
          projectId: input.scope.projectId,
          azureProjectId: input.scope.azureProjectId,
          environmentProfileId: input.environment.profileId,
          envConfigJson: JSON.stringify(input.environment.config),
          storyWorkItemId: input.story?.workItemId ?? null,
          storyTitle: storyTitle || null,
          planSchemaVersion: NATURAL_PLAN_SCHEMA_VERSION,
          actor: input.actor,
          now,
        },
        client,
      );

      // Per-run secret snapshot: profile rows copied verbatim (AES-GCM is
      // location-independent), one-time secrets encrypted directly.
      if (input.environment.profileId) {
        await sqlRun(
          `INSERT INTO test_execution_run_secrets (
             id, run_id, workspace_id, project_id, azure_project_id, secret_name, title,
             encrypted_secret, encryption_iv, encryption_tag, key_version, masked_preview, created_at
           )
           SELECT 'trs_' || md5(random()::text || s.id), @runId, s.workspace_id, s.project_id, s.azure_project_id,
                  s.secret_name, s.title, s.encrypted_secret, s.encryption_iv, s.encryption_tag,
                  s.key_version, s.masked_preview, @now
           FROM test_environment_secrets s
           WHERE s.profile_id = @profileId AND s.workspace_id = @workspaceId`,
          { runId, profileId: input.environment.profileId, workspaceId: input.workspaceId, now },
          client,
        );
      }
      for (const secret of input.environment.oneTimeSecrets) {
        const encrypted = encryptSecret(secret.value);
        await sqlRun(
          `INSERT INTO test_execution_run_secrets (
             id, run_id, workspace_id, project_id, azure_project_id, secret_name, title,
             encrypted_secret, encryption_iv, encryption_tag, key_version, masked_preview, created_at
           ) VALUES (@id, @runId, @workspaceId, @projectId, @azureProjectId, @secretName, @title,
             @ciphertext, @iv, @tag, @keyVersion, @maskedPreview, @now)
           ON CONFLICT (run_id, secret_name) DO NOTHING`,
          {
            id: createId("trs"),
            runId,
            workspaceId: input.workspaceId,
            projectId: input.scope.projectId,
            azureProjectId: input.scope.azureProjectId,
            secretName: secret.secretName,
            title: secret.title,
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            tag: encrypted.tag,
            keyVersion: encrypted.keyVersion,
            maskedPreview: maskSecret(secret.value),
            now,
          },
          client,
        );
      }

      const snapshotIds = new Map<string, string>();
      for (const snapshot of snapshots) {
        const snapshotId = createId("tsnap");
        snapshotIds.set(`${snapshot.kind}:${snapshot.azureWorkItemId}`, snapshotId);
        await sqlRun(
          `INSERT INTO test_execution_source_snapshots (
             id, run_id, workspace_id, project_id, azure_project_id, kind, azure_work_item_id,
             azure_revision, payload_json, content_hash, created_at
           ) VALUES (@id, @runId, @workspaceId, @projectId, @azureProjectId, @kind, @azureWorkItemId,
             @azureRevision, @payloadJson::jsonb, @contentHash, @now)`,
          {
            id: snapshotId,
            runId,
            workspaceId: input.workspaceId,
            projectId: input.scope.projectId,
            azureProjectId: input.scope.azureProjectId,
            kind: snapshot.kind,
            azureWorkItemId: snapshot.azureWorkItemId,
            azureRevision: snapshot.azureRevision,
            payloadJson: JSON.stringify(snapshot.payload),
            contentHash: snapshot.contentHash,
            now,
          },
          client,
        );
      }

      for (const [orderIndex, caseInput] of input.cases.entries()) {
        const caseId = createId("tcr");
        const snapshotKey =
          caseInput.sourceKind === "azure_test_case" && caseInput.azureTestCaseId
            ? snapshotIds.get(`test_case:${caseInput.azureTestCaseId}`) ?? null
            : null;
        await sqlRun(
          `INSERT INTO test_execution_case_runs (
             id, run_id, workspace_id, project_id, azure_project_id, order_index, source_kind,
             source_snapshot_id, title, compiled_plan_json, compile_source, created_at, updated_at
           ) VALUES (@id, @runId, @workspaceId, @projectId, @azureProjectId, @orderIndex, @sourceKind,
             @sourceSnapshotId, @title, @planJson::jsonb, 'natural_text', @now, @now)`,
          {
            id: caseId,
            runId,
            workspaceId: input.workspaceId,
            projectId: input.scope.projectId,
            azureProjectId: input.scope.azureProjectId,
            orderIndex,
            sourceKind: caseInput.sourceKind,
            sourceSnapshotId: snapshotKey,
            title: caseInput.title,
            planJson: JSON.stringify(caseInput.plan),
            now,
          },
          client,
        );
        for (const [stepIndex, step] of caseInput.plan.steps.entries()) {
          await sqlRun(
            `INSERT INTO test_execution_step_runs (
               id, case_run_id, run_id, workspace_id, project_id, azure_project_id,
               order_index, action_json, created_at, updated_at
             ) VALUES (@id, @caseId, @runId, @workspaceId, @projectId, @azureProjectId,
               @orderIndex, @actionJson::jsonb, @now, @now)`,
            {
              id: createId("tsr"),
              caseId,
              runId,
              workspaceId: input.workspaceId,
              projectId: input.scope.projectId,
              azureProjectId: input.scope.azureProjectId,
              orderIndex: stepIndex,
              actionJson: JSON.stringify({
                instruction: step.instruction,
                expectedResult: step.expectedResult,
              }),
              now,
            },
            client,
          );
        }
      }
    });
  } catch (error) {
    if (isActiveRunUniqueViolation(error)) {
      const active = await sqlGet<{ id: string }>(
        `SELECT id FROM test_execution_runs WHERE project_id = @projectId AND status IN ('queued','running')`,
        { projectId: input.scope.projectId },
      );
      throw new ActiveRunConflictError(active?.id ?? null);
    }
    throw error;
  }

  // 4. Enqueue after commit; never leave a queued run without a job.
  let jobId: string | null = null;
  try {
    const enqueued = await enqueueTestExecutionRunJob({
      scope: input.scope,
      workspaceId: input.workspaceId,
      actor: input.actor,
      runId,
    });
    jobId = enqueued.job.id;
  } catch (error) {
    await sqlRun(
      `UPDATE test_execution_runs
       SET status = 'error', outcome = 'infrastructure_error',
           error_message = 'The execution job could not be queued.', finished_at = @now, updated_at = @now
       WHERE id = @runId AND status = 'queued'`,
      { runId, now: nowIso() },
    );
    throw error;
  }

  writeAuditLog({
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    entityType: "test_execution_run",
    entityId: runId,
    action: "test_execution.run_created",
    status: "Success",
    actor: input.actor,
    message: `Test execution run approved and queued (${input.cases.length} case(s)).`,
    details: { jobId, storyWorkItemId: input.story?.workItemId ?? null },
  });
  return { runId, jobId };
}

async function collectAvailableSecretNames(input: CreateRunInput): Promise<string[]> {
  if (input.environment.profileId) {
    const rows = await sqlAll<{ secret_name: string }>(
      `SELECT secret_name FROM test_environment_secrets WHERE profile_id = @profileId AND workspace_id = @workspaceId`,
      { profileId: input.environment.profileId, workspaceId: input.workspaceId },
    );
    return rows.map((row) => row.secret_name);
  }
  return input.environment.oneTimeSecrets.map((secret) => secret.secretName);
}

function isActiveRunUniqueViolation(error: unknown): boolean {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error as { code?: string }).code === "23505" &&
    String((error as { constraint?: string }).constraint ?? "").includes("uq_test_execution_runs_active_project")
  );
}

export async function findActiveRun(input: {
  workspaceId: string;
  scope: ProjectScope;
}): Promise<{ id: string; status: string } | null> {
  const row = await sqlGet<{ id: string; status: string }>(
    `SELECT id, status FROM test_execution_runs
     WHERE workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId
       AND status IN ('queued', 'running')`,
    { workspaceId: input.workspaceId, projectId: input.scope.projectId, azureProjectId: input.scope.azureProjectId },
  );
  return row ?? null;
}

export async function listRuns(input: {
  workspaceId: string;
  scope: ProjectScope;
  limit?: number;
}): Promise<
  {
    id: string;
    status: string;
    outcome: string | null;
    storyWorkItemId: string | null;
    storyTitle: string | null;
    summary: unknown;
    createdAt: string;
    finishedAt: string | null;
  }[]
> {
  const rows = await sqlAll<{
    id: string;
    status: string;
    outcome: string | null;
    story_work_item_id: string | null;
    story_title: string | null;
    summary_json: unknown;
    created_at: string;
    finished_at: string | null;
  }>(
    `SELECT id, status, outcome, story_work_item_id, story_title, summary_json, created_at, finished_at
     FROM test_execution_runs
     WHERE workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId
     ORDER BY created_at DESC
     LIMIT ${Math.min(Math.max(input.limit ?? 20, 1), 100)}`,
    { workspaceId: input.workspaceId, projectId: input.scope.projectId, azureProjectId: input.scope.azureProjectId },
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    outcome: row.outcome,
    storyWorkItemId: row.story_work_item_id,
    storyTitle: row.story_title,
    summary: row.summary_json,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }));
}

export type RunDetailRows = {
  run: Record<string, unknown> | undefined;
  cases: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
  job: { id: string; status: string; cancelRequestedAt: string | null } | null;
};

export async function loadRunDetailRows(input: {
  workspaceId: string;
  scope: ProjectScope;
  runId: string;
}): Promise<RunDetailRows | null> {
  const scopeWhere = `workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId`;
  const params = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
  };
  const run = await sqlGet<Record<string, unknown>>(
    `SELECT * FROM test_execution_runs WHERE id = @runId AND ${scopeWhere}`,
    params,
  );
  if (!run) return null;
  const [cases, steps, artifacts, candidates, job] = await Promise.all([
    sqlAll<Record<string, unknown>>(
      `SELECT * FROM test_execution_case_runs WHERE run_id = @runId AND ${scopeWhere} ORDER BY order_index`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT * FROM test_execution_step_runs WHERE run_id = @runId AND ${scopeWhere} ORDER BY order_index`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT id, run_id, case_run_id, step_run_id, kind, mime_type, byte_size, file_name, created_at
       FROM test_execution_artifacts WHERE run_id = @runId AND ${scopeWhere} ORDER BY created_at`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT * FROM test_defect_candidates WHERE run_id = @runId AND ${scopeWhere} ORDER BY created_at`,
      params,
    ),
    sqlGet<{ id: string; status: string; cancel_requested_at: string | null }>(
      `SELECT id, status, cancel_requested_at FROM jobs
       WHERE id = (SELECT job_id FROM test_execution_runs WHERE id = @runId)`,
      { runId: input.runId },
    ),
  ]);
  return {
    run,
    cases,
    steps,
    artifacts,
    candidates,
    job: job ? { id: job.id, status: job.status, cancelRequestedAt: job.cancel_requested_at } : null,
  };
}

/** Resolve a saved profile into the frozen run config shape. */
export function profileToEnvConfig(profile: {
  initialUrl: string;
  allowedOrigin: string;
  viewportWidth: number;
  viewportHeight: number;
  headless: boolean;
  defaultTimeoutMs: number;
  navigationTimeoutMs: number;
  evidenceLevel: "minimal" | "on_failure" | "all_steps";
  loginPlan: unknown;
}): EnvConfig {
  return {
    initialUrl: profile.initialUrl,
    allowedOrigin: profile.allowedOrigin,
    viewportWidth: profile.viewportWidth,
    viewportHeight: profile.viewportHeight,
    headless: profile.headless,
    defaultTimeoutMs: profile.defaultTimeoutMs,
    navigationTimeoutMs: profile.navigationTimeoutMs,
    evidenceLevel: profile.evidenceLevel,
    loginPlan: (profile.loginPlan as NaturalPlan | null) ?? null,
  };
}
