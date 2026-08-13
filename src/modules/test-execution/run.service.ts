import "server-only";

import type { PoolClient } from "pg";

import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { encryptSecret, maskSecret } from "@/modules/security/encryption.service";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { enqueueTestExecutionRunJob } from "@/modules/jobs/test-execution-jobs.service";
import { getUserDisplayNames } from "@/modules/auth/user.service";
import {
  createId,
  isPgUniqueViolation,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";

import { NATURAL_PLAN_SCHEMA_VERSION, type NaturalPlan } from "./action-schema";
import { configuredEnvironmentLayers } from "./environment-layers";
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

export class RunCapabilityValidationError extends Error {
  constructor(readonly reason: "unavailable" | "duplicate_stable_key" = "unavailable") {
    super("One or more integration capabilities are unavailable, unapproved, or incompatible with the environment.");
    this.name = "RunCapabilityValidationError";
  }
}

export class RunEnvironmentSnapshotConflictError extends Error {
  constructor() {
    super("The selected environment profile changed after review. Refresh it and approve the run again.");
    this.name = "RunEnvironmentSnapshotConflictError";
  }
}

export type CreateRunInput = {
  workspaceId: string;
  scope: ProjectScope;
  actor: string;
  adapter: AzureDevOpsAdapter;
  environment: {
    profileId: string | null;
    /** Optimistic version captured with the reviewed saved-profile config. */
    profileUpdatedAt: string | null;
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
  const availableLayers = configuredEnvironmentLayers(input.environment.config);
  const allFindings: PlanFinding[] = [];
  for (const caseInput of input.cases) {
    const validation = validateNaturalPlan(caseInput.plan, {
      availableSecretNames: secretNames,
      availableLayers,
    });
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
      await lockReviewedEnvironmentProfile(client, input);

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

      // Operation pinning was removed with the manual capability catalog: a
      // new run's API/DB surface derives entirely from its frozen environment
      // (contract revision + explicit step text). Historical runs keep their
      // pinned operation rows readable through run-persistence.
      const apiContractRevisionId =
        input.environment.config.api?.contract?.kind === "revision"
          ? input.environment.config.api.contract.revisionId
          : null;
      if (apiContractRevisionId) {
        const inserted = await sqlRun(
          `INSERT INTO test_execution_run_capabilities (
             id, run_id, workspace_id, project_id, azure_project_id,
             capability_kind, api_contract_revision_id, created_at
           )
           SELECT @id, @runId, c.workspace_id, c.project_id, c.azure_project_id,
                  'api_contract', c.id, @now
           FROM test_api_contract_revisions c
           WHERE c.id = @apiContractRevisionId
             AND c.workspace_id = @workspaceId
             AND c.project_id = @projectId
             AND c.azure_project_id = @azureProjectId`,
          {
            id: createId("trcap"),
            runId,
            apiContractRevisionId,
            workspaceId: input.workspaceId,
            projectId: input.scope.projectId,
            azureProjectId: input.scope.azureProjectId,
            now,
          },
          client,
        );
        if (inserted !== 1) throw new RunCapabilityValidationError();
      }

      // No capability row may be added after this transaction publishes the
      // run. A database trigger enforces the marker for every later insert.
      await sqlRun(
        `UPDATE test_execution_runs
         SET capability_snapshot_frozen_at = @now
         WHERE id = @runId AND capability_snapshot_frozen_at IS NULL`,
        { runId, now },
        client,
      );

      // Per-run secret snapshot: profile rows copied verbatim (AES-GCM is
      // location-independent), one-time secrets encrypted directly.
      if (input.environment.profileId) {
        await sqlRun(
          `INSERT INTO test_execution_run_secrets (
             id, run_id, workspace_id, project_id, azure_project_id, secret_name, title,
             purpose, encrypted_secret, encryption_iv, encryption_tag, key_version, masked_preview, created_at
           )
           SELECT 'trs_' || md5(random()::text || s.id), @runId, s.workspace_id, s.project_id, s.azure_project_id,
                  s.secret_name, s.title, s.purpose, s.encrypted_secret, s.encryption_iv, s.encryption_tag,
                  s.key_version, s.masked_preview, @now
           FROM test_environment_secrets s
           WHERE s.profile_id = @profileId AND s.workspace_id = @workspaceId
             AND s.project_id = @projectId AND s.azure_project_id = @azureProjectId`,
          {
            runId,
            profileId: input.environment.profileId,
            workspaceId: input.workspaceId,
            projectId: input.scope.projectId,
            azureProjectId: input.scope.azureProjectId,
            now,
          },
          client,
        );
      }
      for (const secret of input.environment.oneTimeSecrets) {
        const encrypted = encryptSecret(secret.value);
        await sqlRun(
          `INSERT INTO test_execution_run_secrets (
             id, run_id, workspace_id, project_id, azure_project_id, secret_name, title,
             purpose, encrypted_secret, encryption_iv, encryption_tag, key_version, masked_preview, created_at
           ) VALUES (@id, @runId, @workspaceId, @projectId, @azureProjectId, @secretName, @title,
             @purpose, @ciphertext, @iv, @tag, @keyVersion, @maskedPreview, @now)
           ON CONFLICT (run_id, secret_name) DO NOTHING`,
          {
            id: createId("trs"),
            runId,
            workspaceId: input.workspaceId,
            projectId: input.scope.projectId,
            azureProjectId: input.scope.azureProjectId,
            secretName: secret.secretName,
            title: secret.title,
            purpose: secret.purpose,
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
      `SELECT secret_name FROM test_environment_secrets
       WHERE profile_id = @profileId AND workspace_id = @workspaceId AND purpose = 'agent_value'`,
      { profileId: input.environment.profileId, workspaceId: input.workspaceId },
    );
    return rows.map((row) => row.secret_name);
  }
  return input.environment.oneTimeSecrets
    .filter((secret) => secret.purpose === "agent_value")
    .map((secret) => secret.secretName);
}

/**
 * Keep the reviewed saved-profile version and its encrypted secret rows under
 * one database snapshot. Profile mutations take a row lock and advance
 * updated_at before touching secrets, so this share lock either observes the
 * reviewed version or rejects the run without freezing a torn configuration.
 */
async function lockReviewedEnvironmentProfile(
  client: PoolClient,
  input: CreateRunInput,
): Promise<void> {
  if (!input.environment.profileId) return;
  const profile = await sqlGet<{ updated_at: string; lifecycle_status: string }>(
    `SELECT updated_at, lifecycle_status
     FROM test_environment_profiles
     WHERE id = @profileId AND workspace_id = @workspaceId
       AND project_id = @projectId AND azure_project_id = @azureProjectId
     FOR SHARE`,
    {
      profileId: input.environment.profileId,
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
    },
    client,
  );
  if (
    !profile ||
    profile.lifecycle_status !== "active" ||
    !input.environment.profileUpdatedAt ||
    profile.updated_at !== input.environment.profileUpdatedAt
  ) {
    throw new RunEnvironmentSnapshotConflictError();
  }
}

function isActiveRunUniqueViolation(error: unknown): boolean {
  return isPgUniqueViolation(error, "uq_test_execution_runs_active_project");
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
    /** Saved profile name; null for one-time environments. */
    environmentName: string | null;
    caseCount: number;
    createdByName: string | null;
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
    environment_name: string | null;
    case_count: string | number;
    created_by: string | null;
    summary_json: unknown;
    created_at: string;
    finished_at: string | null;
  }>(
    `SELECT r.id, r.status, r.outcome, r.story_work_item_id, r.story_title, r.created_by,
            r.summary_json, r.created_at, r.finished_at,
            p.name AS environment_name,
            (SELECT COUNT(*) FROM test_execution_case_runs c WHERE c.run_id = r.id) AS case_count
     FROM test_execution_runs r
     LEFT JOIN test_environment_profiles p ON p.id = r.environment_profile_id
     WHERE r.workspace_id = @workspaceId AND r.project_id = @projectId AND r.azure_project_id = @azureProjectId
     ORDER BY r.created_at DESC
     LIMIT ${Math.min(Math.max(input.limit ?? 20, 1), 100)}`,
    { workspaceId: input.workspaceId, projectId: input.scope.projectId, azureProjectId: input.scope.azureProjectId },
  );
  const names = await getUserDisplayNames(
    rows.map((row) => row.created_by).filter((id): id is string => Boolean(id)),
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    outcome: row.outcome,
    storyWorkItemId: row.story_work_item_id,
    storyTitle: row.story_title,
    environmentName: row.environment_name,
    caseCount: Number(row.case_count),
    createdByName: row.created_by ? names.get(row.created_by) ?? "a removed user" : null,
    summary: row.summary_json,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  }));
}

export type RunDetailRows = {
  run: Record<string, unknown> | undefined;
  /** Resolved display name of the approver (approved_by is a user id). */
  approvedByName: string | null;
  cases: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  actions?: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
  job: { id: string; status: string; cancelRequestedAt: string | null } | null;
  /**
   * Change-sequence boundary captured BEFORE the snapshot rows were read.
   * A change landing during the read may be delivered again incrementally
   * (safe — the client merge is idempotent); it can never be skipped.
   */
  cursor: string;
};

/** Current global change-sequence boundary ("0" before any stamped write). */
async function readChangeSequenceBoundary(): Promise<string> {
  const row = await sqlGet<{ boundary: string }>(
    `SELECT CASE WHEN is_called THEN last_value ELSE 0 END::text AS boundary
     FROM test_execution_change_seq`,
  );
  return row?.boundary ?? "0";
}

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
  const cursor = await readChangeSequenceBoundary();
  const run = await sqlGet<Record<string, unknown>>(
    `SELECT * FROM test_execution_runs WHERE id = @runId AND ${scopeWhere}`,
    params,
  );
  if (!run) return null;
  const [cases, steps, actions, artifacts, candidates, job] = await Promise.all([
    sqlAll<Record<string, unknown>>(
      `SELECT c.*, s.azure_work_item_id
       FROM test_execution_case_runs c
       LEFT JOIN test_execution_source_snapshots s ON s.id = c.source_snapshot_id
       WHERE c.run_id = @runId AND c.workspace_id = @workspaceId
         AND c.project_id = @projectId AND c.azure_project_id = @azureProjectId
       ORDER BY c.order_index`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT * FROM test_execution_step_runs WHERE run_id = @runId AND ${scopeWhere} ORDER BY order_index`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT id, step_run_id, case_run_id, run_id, order_index, layer, action_type, safety_class,
              request_json, status, observation_json, error_category, error_message,
              started_at, finished_at
       FROM test_execution_action_runs
       WHERE run_id = @runId AND ${scopeWhere}
       ORDER BY step_run_id, order_index`,
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
  const approverName = run.approved_by
    ? (await getUserDisplayNames([String(run.approved_by)])).get(String(run.approved_by)) ?? null
    : null;
  return {
    run,
    approvedByName: approverName,
    cases,
    steps,
    actions,
    artifacts,
    candidates,
    job: job ? { id: job.id, status: job.status, cancelRequestedAt: job.cancel_requested_at } : null,
    cursor,
  };
}

/** Per-type page bound for incremental polls; a capped poll signals hasMore
 * and the client falls back to one full snapshot fetch. */
const RUN_DETAIL_CHANGES_LIMIT = 1_000;

export type RunDetailChangeRows = {
  run: Record<string, unknown>;
  cases: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  artifacts: Record<string, unknown>[];
  candidates: Record<string, unknown>[];
  job: { id: string; status: string; cancelRequestedAt: string | null } | null;
  nextCursor: string;
  hasMore: boolean;
};

/**
 * Incremental run-detail rows: only case/step/action rows whose change_seq
 * moved past the client's cursor. The run row, artifacts, candidates, and job
 * are tiny and always included; the heavy JSONB payloads (actions) ship only
 * when they actually changed (V10-5).
 */
export async function loadRunDetailChangeRows(input: {
  workspaceId: string;
  scope: ProjectScope;
  runId: string;
  afterCursor: string;
}): Promise<RunDetailChangeRows | null> {
  const scopeWhere = `workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId`;
  const params = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    afterCursor: input.afterCursor,
    limit: RUN_DETAIL_CHANGES_LIMIT,
  };
  const run = await sqlGet<Record<string, unknown>>(
    `SELECT * FROM test_execution_runs WHERE id = @runId AND ${scopeWhere}`,
    params,
  );
  if (!run) return null;
  const [cases, steps, actions, artifacts, candidates, job] = await Promise.all([
    sqlAll<Record<string, unknown>>(
      `SELECT c.*, s.azure_work_item_id
       FROM test_execution_case_runs c
       LEFT JOIN test_execution_source_snapshots s ON s.id = c.source_snapshot_id
       WHERE c.run_id = @runId AND c.workspace_id = @workspaceId
         AND c.project_id = @projectId AND c.azure_project_id = @azureProjectId
         AND c.change_seq > @afterCursor::bigint
       ORDER BY c.change_seq LIMIT @limit`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT * FROM test_execution_step_runs
       WHERE run_id = @runId AND ${scopeWhere} AND change_seq > @afterCursor::bigint
       ORDER BY change_seq LIMIT @limit`,
      params,
    ),
    sqlAll<Record<string, unknown>>(
      `SELECT id, step_run_id, case_run_id, run_id, order_index, layer, action_type, safety_class,
              request_json, status, observation_json, error_category, error_message,
              started_at, finished_at, change_seq
       FROM test_execution_action_runs
       WHERE run_id = @runId AND ${scopeWhere} AND change_seq > @afterCursor::bigint
       ORDER BY change_seq LIMIT @limit`,
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
  const hasMore =
    cases.length >= RUN_DETAIL_CHANGES_LIMIT ||
    steps.length >= RUN_DETAIL_CHANGES_LIMIT ||
    actions.length >= RUN_DETAIL_CHANGES_LIMIT;
  // Without a cap, the cursor advances to the largest sequence seen (the run
  // row included). With a cap, the client falls back to a full snapshot, so
  // the cursor value is not used to resume mid-page.
  let nextCursor = BigInt(input.afterCursor || "0");
  for (const row of [run, ...cases, ...steps, ...actions]) {
    const seq = row.change_seq === undefined || row.change_seq === null ? null : BigInt(String(row.change_seq));
    if (seq !== null && seq > nextCursor) nextCursor = seq;
  }
  return {
    run,
    cases,
    steps,
    actions,
    artifacts,
    candidates,
    job: job ? { id: job.id, status: job.status, cancelRequestedAt: job.cancel_requested_at } : null,
    nextCursor: nextCursor.toString(),
    hasMore,
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
  loginMode: "session" | "fresh";
  loggedInText: string;
  executionNotes: string;
  users: { handle: string; username: string; passwordSecretName: string | null; notes: string }[];
  api: EnvConfig["api"];
  database: EnvConfig["database"];
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
    loginMode: profile.loginMode,
    loggedInText: profile.loggedInText,
    executionNotes: profile.executionNotes,
    // Per-run notes are supplied by the run route, not the profile.
    runNotes: "",
    users: profile.users.map((user) => ({
      handle: user.handle,
      username: user.username,
      passwordSecretName: user.passwordSecretName,
      notes: user.notes,
    })),
    api: profile.api,
    database: profile.database,
  };
}
