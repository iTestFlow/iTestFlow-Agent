import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import type { WorkflowRunStatus } from "@/types/system-dashboard";
import {
  defaultWorkflowBaselines,
  type WorkflowType,
} from "./analytics-config";
import {
  calculateElapsedMinutes,
  calculateEstimatedSavings,
  isRealizedValue,
} from "./analytics-metrics";

type WorkflowRunRow = {
  id: string;
  status: WorkflowRunStatus;
  started_at: string;
  manual_baseline_minutes: number;
  items_generated: number;
  items_selected: number;
  items_published: number;
  actual_duration_minutes: number | null;
};

export type WorkflowRunPatch = Partial<{
  workItemId: string | null;
  sourceRunId: string | null;
  generationStartedAt: string | null;
  generationCompletedAt: string | null;
  reviewStartedAt: string | null;
  publishedAt: string | null;
  status: WorkflowRunStatus;
  itemsGenerated: number;
  itemsSelected: number;
  itemsEdited: number;
  itemsPublished: number;
  itemsRejected: number;
  highRiskItemsFound: number;
  mediumRiskItemsFound: number;
  lowRiskItemsFound: number;
  manualActionsAvoided: number;
  usedKnowledgeContext: boolean;
  metadata: Record<string, unknown>;
}>;

export function startWorkflowRun(input: {
  scope: ProjectScope;
  workflowType: WorkflowType;
  workItemId?: string;
  sourceRunId?: string;
  userId?: string;
  generationStartedAt?: string;
  metadata?: Record<string, unknown>;
}) {
  // The id is generated up front and always returned so callers can correlate the
  // request even if persistence fails — analytics is best-effort and must never
  // throw into the request path (see runQuietly).
  const id = createId("workflow");
  runQuietly("startWorkflowRun", () => {
    const scope = assertProjectScope(input.scope);
    const now = nowIso();
    const baseline = getWorkflowBaseline(input.workflowType);

    getDatabase().prepare(
      `INSERT INTO analytics_workflow_runs (
        id, project_id, azure_project_id, user_id, workflow_type, work_item_id, source_run_id,
        started_at, generation_started_at, status, manual_baseline_minutes, metadata_json,
        created_at, updated_at
      ) VALUES (
        @id, @projectId, @azureProjectId, @userId, @workflowType, @workItemId, @sourceRunId,
        @startedAt, @generationStartedAt, 'started', @manualBaselineMinutes, @metadataJson,
        @createdAt, @updatedAt
      )`,
    ).run({
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      userId: input.userId ?? "local-user",
      workflowType: input.workflowType,
      workItemId: input.workItemId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      startedAt: now,
      generationStartedAt: input.generationStartedAt ?? now,
      manualBaselineMinutes: baseline,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
      createdAt: now,
      updatedAt: now,
    });
  });

  return id;
}

export function updateWorkflowRun(input: Parameters<typeof updateWorkflowRunImpl>[0]) {
  runQuietly("updateWorkflowRun", () => updateWorkflowRunImpl(input));
}

function updateWorkflowRunImpl(input: {
  scope: ProjectScope;
  runId: string;
  patch: WorkflowRunPatch;
}) {
  const scope = assertProjectScope(input.scope);
  const assignments: string[] = [];
  const params: Record<string, unknown> = {
    runId: input.runId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    updatedAt: nowIso(),
  };
  const mappings: Array<[keyof WorkflowRunPatch, string, (value: never) => unknown]> = [
    ["workItemId", "work_item_id", identity],
    ["sourceRunId", "source_run_id", identity],
    ["generationStartedAt", "generation_started_at", identity],
    ["generationCompletedAt", "generation_completed_at", identity],
    ["reviewStartedAt", "review_started_at", identity],
    ["publishedAt", "published_at", identity],
    ["status", "status", identity],
    ["itemsGenerated", "items_generated", nonNegative],
    ["itemsSelected", "items_selected", nonNegative],
    ["itemsEdited", "items_edited", nonNegative],
    ["itemsPublished", "items_published", nonNegative],
    ["itemsRejected", "items_rejected", nonNegative],
    ["highRiskItemsFound", "high_risk_items_found", nonNegative],
    ["mediumRiskItemsFound", "medium_risk_items_found", nonNegative],
    ["lowRiskItemsFound", "low_risk_items_found", nonNegative],
    ["manualActionsAvoided", "manual_actions_avoided", nonNegative],
    ["usedKnowledgeContext", "used_knowledge_context", booleanInteger],
    ["metadata", "metadata_json", jsonValue],
  ];

  for (const [key, column, normalize] of mappings) {
    if (input.patch[key] === undefined) continue;
    assignments.push(`${column} = @${String(key)}`);
    params[String(key)] = normalize(input.patch[key] as never);
  }
  if (!assignments.length) return;
  assignments.push("updated_at = @updatedAt");

  getDatabase().prepare(
    `UPDATE analytics_workflow_runs
     SET ${assignments.join(", ")}
     WHERE id = @runId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
  ).run(params);

  if (input.patch.generationCompletedAt) {
    const row = getRun(scope, input.runId);
    const generationDuration = row
      ? calculateElapsedMinutes(row.started_at, input.patch.generationCompletedAt)
      : null;
    if (generationDuration !== null) {
      getDatabase().prepare(
        `UPDATE analytics_workflow_runs
         SET actual_duration_minutes = @actualDurationMinutes
         WHERE id = @runId AND project_id = @projectId AND azure_project_id = @azureProjectId
           AND completed_at IS NULL`,
      ).run({
        runId: input.runId,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        actualDurationMinutes: generationDuration,
      });
    }
  }
}

export function completeWorkflowRun(input: Parameters<typeof completeWorkflowRunImpl>[0]) {
  runQuietly("completeWorkflowRun", () => completeWorkflowRunImpl(input));
}

function completeWorkflowRunImpl(input: {
  scope: ProjectScope;
  runId: string;
  status?: "published" | "completed";
  valueRealized?: boolean;
  patch?: WorkflowRunPatch;
}) {
  const scope = assertProjectScope(input.scope);
  const row = getRun(scope, input.runId);
  if (!row) return;
  const completedAt = nowIso();
  const actualDurationMinutes = Math.max(
    (new Date(completedAt).getTime() - new Date(row.started_at).getTime()) / 60_000,
    0,
  );
  const patch = input.patch ?? {};
  const itemsSelected = patch.itemsSelected ?? row.items_selected;
  const itemsPublished = patch.itemsPublished ?? row.items_published;
  const realized = input.valueRealized ?? isRealizedValue({
    itemsPublished,
    itemsSelected,
  });
  const estimatedSavedMinutes = realized
    ? calculateEstimatedSavings(row.manual_baseline_minutes, actualDurationMinutes)
    : 0;

  updateWorkflowRunImpl({ scope, runId: input.runId, patch });
  getDatabase().prepare(
    `UPDATE analytics_workflow_runs
     SET status = @status, completed_at = @completedAt,
         published_at = CASE WHEN @status = 'published' THEN @completedAt ELSE published_at END,
         actual_duration_minutes = @actualDurationMinutes,
         estimated_saved_minutes = @estimatedSavedMinutes,
         updated_at = @completedAt
     WHERE id = @runId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
  ).run({
    runId: input.runId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    status: input.status ?? "completed",
    completedAt,
    actualDurationMinutes,
    estimatedSavedMinutes,
  });
}

export function failWorkflowRun(input: Parameters<typeof failWorkflowRunImpl>[0]) {
  runQuietly("failWorkflowRun", () => failWorkflowRunImpl(input));
}

function failWorkflowRunImpl(input: {
  scope: ProjectScope;
  runId: string;
  error?: string;
  cancelled?: boolean;
}) {
  const scope = assertProjectScope(input.scope);
  const row = getRun(scope, input.runId);
  if (!row) return;
  const completedAt = nowIso();
  const actualDurationMinutes = Math.max(
    (new Date(completedAt).getTime() - new Date(row.started_at).getTime()) / 60_000,
    0,
  );
  const metadata = input.error ? JSON.stringify({ error: input.error }) : null;
  getDatabase().prepare(
    `UPDATE analytics_workflow_runs
     SET status = @status, completed_at = @completedAt, actual_duration_minutes = @actualDurationMinutes,
         estimated_saved_minutes = 0,
         metadata_json = COALESCE(@metadataJson, metadata_json), updated_at = @completedAt
     WHERE id = @runId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
  ).run({
    runId: input.runId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    status: input.cancelled ? "cancelled" : "failed",
    completedAt,
    actualDurationMinutes,
    metadataJson: metadata,
  });
}

function getWorkflowBaseline(workflowType: WorkflowType) {
  return getEffectiveRuntimeSettings()?.dashboardValueMetrics?.manualBaselineMinutes?.[workflowType]
    ?? defaultWorkflowBaselines[workflowType];
}

function getRun(scope: ProjectScope, runId: string) {
  return getDatabase().prepare(
    `SELECT id, status, started_at, manual_baseline_minutes, items_generated, items_selected,
            items_published, actual_duration_minutes
     FROM analytics_workflow_runs
     WHERE id = @runId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
  ).get({
    runId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  }) as WorkflowRunRow | undefined;
}

function identity(value: never) {
  return value;
}

function nonNegative(value: never) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function booleanInteger(value: never) {
  return value ? 1 : 0;
}

function jsonValue(value: never) {
  return JSON.stringify(value);
}

// Analytics instrumentation is best-effort telemetry: it must never throw into the
// request path. A persistence failure here should be logged and swallowed, never
// allowed to turn a successful primary operation into an error response.
function runQuietly(label: string, run: () => void) {
  try {
    run();
  } catch (error) {
    console.error(`[workflow-analytics] ${label} failed; skipping instrumentation.`, error);
  }
}
