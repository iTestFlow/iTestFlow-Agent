import "server-only";

import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";

export type ContextAutoUpdateRunStatus = "Running" | "Success" | "Failed" | "Partial failure";

export type ContextAutoUpdateRunSummary = {
  id: string;
  projectId: string;
  azureProjectId: string;
  azureProjectName: string;
  azureOrganizationUrl: string;
  cronExpression: string;
  workItemTypes: string[];
  states: string[];
  status: ContextAutoUpdateRunStatus;
  startedAt: string;
  completedAt?: string | null;
  contextFetchedCount: number;
  contextIndexedWorkItemCount: number;
  contextIndexedChunkCount: number;
  knowledgeBaseId?: string | null;
  knowledgeSourceWorkItemCount: number;
  errorDetails?: string | null;
};

type ContextAutoUpdateRunRow = {
  id: string;
  project_id: string;
  azure_project_id: string;
  azure_project_name: string;
  azure_organization_url: string;
  cron_expression: string;
  context_work_item_types: string | null;
  context_states: string | null;
  status: ContextAutoUpdateRunStatus;
  started_at: string;
  completed_at: string | null;
  context_fetched_count: number;
  context_indexed_work_item_count: number;
  context_indexed_chunk_count: number;
  knowledge_base_id: string | null;
  knowledge_source_work_item_count: number;
  error_details: string | null;
};

export function startContextAutoUpdateRun(input: {
  scope: ProjectScope;
  cronExpression: string;
  workItemTypes: string[];
  states: string[];
}) {
  const db = getDatabase();
  ensureContextAutoUpdateRunFilterColumns(db);
  const now = nowIso();
  const id = createId("cau");

  db.prepare(
    `
    INSERT INTO context_auto_update_runs (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      cron_expression, context_work_item_types, context_states, status, started_at, completed_at,
      context_fetched_count, context_indexed_work_item_count, context_indexed_chunk_count,
      knowledge_base_id, knowledge_source_work_item_count, error_details,
      created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @cronExpression, @workItemTypes, @states, 'Running', @startedAt, NULL,
      0, 0, 0,
      NULL, 0, NULL,
      @createdAt, @updatedAt
    )
  `,
  ).run({
    id,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    cronExpression: input.cronExpression,
    workItemTypes: JSON.stringify(input.workItemTypes),
    states: JSON.stringify(input.states),
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

export function completeContextAutoUpdateRun(input: {
  id: string;
  status: Exclude<ContextAutoUpdateRunStatus, "Running">;
  contextFetchedCount?: number;
  contextIndexedWorkItemCount?: number;
  contextIndexedChunkCount?: number;
  knowledgeBaseId?: string | null;
  knowledgeSourceWorkItemCount?: number;
  errorDetails?: string | null;
}) {
  const db = getDatabase();
  const now = nowIso();
  db.prepare(
    `
    UPDATE context_auto_update_runs
    SET status = @status,
        completed_at = @completedAt,
        context_fetched_count = @contextFetchedCount,
        context_indexed_work_item_count = @contextIndexedWorkItemCount,
        context_indexed_chunk_count = @contextIndexedChunkCount,
        knowledge_base_id = @knowledgeBaseId,
        knowledge_source_work_item_count = @knowledgeSourceWorkItemCount,
        error_details = @errorDetails,
        updated_at = @updatedAt
    WHERE id = @id
  `,
  ).run({
    id: input.id,
    status: input.status,
    completedAt: now,
    contextFetchedCount: input.contextFetchedCount ?? 0,
    contextIndexedWorkItemCount: input.contextIndexedWorkItemCount ?? 0,
    contextIndexedChunkCount: input.contextIndexedChunkCount ?? 0,
    knowledgeBaseId: input.knowledgeBaseId ?? null,
    knowledgeSourceWorkItemCount: input.knowledgeSourceWorkItemCount ?? 0,
    errorDetails: input.errorDetails ?? null,
    updatedAt: now,
  });
}

export function getLatestContextAutoUpdateRun() {
  const db = getDatabase();
  ensureContextAutoUpdateRunFilterColumns(db);
  const row = db.prepare(
    `
    SELECT id, project_id, azure_project_id, azure_project_name, azure_organization_url,
           cron_expression, context_work_item_types, context_states, status, started_at, completed_at,
           context_fetched_count, context_indexed_work_item_count, context_indexed_chunk_count,
           knowledge_base_id, knowledge_source_work_item_count, error_details
    FROM context_auto_update_runs
    ORDER BY started_at DESC
    LIMIT 1
  `,
  ).get() as ContextAutoUpdateRunRow | undefined;

  return row ? toContextAutoUpdateRunSummary(row) : null;
}

function toContextAutoUpdateRunSummary(row: ContextAutoUpdateRunRow): ContextAutoUpdateRunSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    azureProjectId: row.azure_project_id,
    azureProjectName: row.azure_project_name,
    azureOrganizationUrl: row.azure_organization_url,
    cronExpression: row.cron_expression,
    workItemTypes: parseStringArray(row.context_work_item_types),
    states: parseStringArray(row.context_states),
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    contextFetchedCount: row.context_fetched_count,
    contextIndexedWorkItemCount: row.context_indexed_work_item_count,
    contextIndexedChunkCount: row.context_indexed_chunk_count,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeSourceWorkItemCount: row.knowledge_source_work_item_count,
    errorDetails: row.error_details,
  };
}

function ensureContextAutoUpdateRunFilterColumns(db: ReturnType<typeof getDatabase>) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(context_auto_update_runs)").all() as Array<{ name: string }>).map((column) => column.name),
  );

  if (!columns.has("context_work_item_types")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_work_item_types TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("context_states")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_states TEXT NOT NULL DEFAULT '[]'");
  }
}

function parseStringArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
