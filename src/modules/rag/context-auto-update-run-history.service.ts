import "server-only";

import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";

export type ContextAutoUpdateRunStatus = "Running" | "Success" | "Failed" | "Partial failure";
export type ContextAutoUpdateKnowledgeCompileStatus = "pending" | "compiled" | "skipped" | "failed";

export type ContextAutoUpdateRunSummary = {
  id: string;
  projectId: string;
  azureProjectId: string;
  azureProjectName: string;
  azureOrganizationUrl: string;
  cronExpression: string;
  cronTimezone: string;
  workItemTypes: string[];
  states: string[];
  status: ContextAutoUpdateRunStatus;
  startedAt: string;
  completedAt?: string | null;
  contextSyncMode?: string | null;
  contextFetchedCount: number;
  contextIndexedWorkItemCount: number;
  contextIndexedChunkCount: number;
  contextCreatedCount: number;
  contextUpdatedCount: number;
  contextUnchangedCount: number;
  contextInactiveCount: number;
  contextSkippedEmptyCount: number;
  knowledgeBaseId?: string | null;
  knowledgeSourceWorkItemCount: number;
  knowledgeCompileMode?: string | null;
  knowledgeCompileStatus: ContextAutoUpdateKnowledgeCompileStatus;
  knowledgeCompileSkippedReason?: string | null;
  errorDetails?: string | null;
};

type ContextAutoUpdateRunRow = {
  id: string;
  project_id: string;
  azure_project_id: string;
  azure_project_name: string;
  azure_organization_url: string;
  cron_expression: string;
  cron_timezone: string;
  context_work_item_types: string | null;
  context_states: string | null;
  status: ContextAutoUpdateRunStatus;
  started_at: string;
  completed_at: string | null;
  context_sync_mode: string | null;
  context_fetched_count: number;
  context_indexed_work_item_count: number;
  context_indexed_chunk_count: number;
  context_created_count: number;
  context_updated_count: number;
  context_unchanged_count: number;
  context_inactive_count: number;
  context_skipped_empty_count: number;
  knowledge_base_id: string | null;
  knowledge_source_work_item_count: number;
  knowledge_compile_mode: string | null;
  knowledge_compile_status: ContextAutoUpdateKnowledgeCompileStatus | null;
  knowledge_compile_skipped_reason: string | null;
  error_details: string | null;
};

export function startContextAutoUpdateRun(input: {
  scope: ProjectScope;
  cronExpression: string;
  cronTimezone: string;
  workItemTypes: string[];
  states: string[];
  contextSyncMode: string;
  knowledgeCompileMode: string;
}) {
  const db = getDatabase();
  ensureContextAutoUpdateRunColumns(db);
  const now = nowIso();
  const id = createId("cau");

  db.prepare(
    `
    INSERT INTO context_auto_update_runs (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      cron_expression, cron_timezone, context_work_item_types, context_states, status, started_at, completed_at,
      context_sync_mode, context_fetched_count, context_indexed_work_item_count, context_indexed_chunk_count,
      context_created_count, context_updated_count, context_unchanged_count, context_inactive_count,
      context_skipped_empty_count, knowledge_base_id, knowledge_source_work_item_count,
      knowledge_compile_mode, knowledge_compile_status, knowledge_compile_skipped_reason, error_details,
      created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @cronExpression, @cronTimezone, @workItemTypes, @states, 'Running', @startedAt, NULL,
      @contextSyncMode, 0, 0, 0,
      0, 0, 0, 0,
      0, NULL, 0,
      @knowledgeCompileMode, 'pending', NULL, NULL,
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
    cronTimezone: input.cronTimezone,
    workItemTypes: JSON.stringify(input.workItemTypes),
    states: JSON.stringify(input.states),
    contextSyncMode: input.contextSyncMode,
    knowledgeCompileMode: input.knowledgeCompileMode,
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });

  return id;
}

export function completeContextAutoUpdateRun(input: {
  id: string;
  status: Exclude<ContextAutoUpdateRunStatus, "Running">;
  cronTimezone?: string;
  contextSyncMode?: string | null;
  contextFetchedCount?: number;
  contextIndexedWorkItemCount?: number;
  contextIndexedChunkCount?: number;
  contextCreatedCount?: number;
  contextUpdatedCount?: number;
  contextUnchangedCount?: number;
  contextInactiveCount?: number;
  contextSkippedEmptyCount?: number;
  knowledgeBaseId?: string | null;
  knowledgeSourceWorkItemCount?: number;
  knowledgeCompileMode?: string | null;
  knowledgeCompileStatus?: ContextAutoUpdateKnowledgeCompileStatus;
  knowledgeCompileSkippedReason?: string | null;
  errorDetails?: string | null;
}) {
  const db = getDatabase();
  ensureContextAutoUpdateRunColumns(db);
  const now = nowIso();
  db.prepare(
    `
    UPDATE context_auto_update_runs
    SET status = @status,
        completed_at = @completedAt,
        cron_timezone = @cronTimezone,
        context_sync_mode = @contextSyncMode,
        context_fetched_count = @contextFetchedCount,
        context_indexed_work_item_count = @contextIndexedWorkItemCount,
        context_indexed_chunk_count = @contextIndexedChunkCount,
        context_created_count = @contextCreatedCount,
        context_updated_count = @contextUpdatedCount,
        context_unchanged_count = @contextUnchangedCount,
        context_inactive_count = @contextInactiveCount,
        context_skipped_empty_count = @contextSkippedEmptyCount,
        knowledge_base_id = @knowledgeBaseId,
        knowledge_source_work_item_count = @knowledgeSourceWorkItemCount,
        knowledge_compile_mode = @knowledgeCompileMode,
        knowledge_compile_status = @knowledgeCompileStatus,
        knowledge_compile_skipped_reason = @knowledgeCompileSkippedReason,
        error_details = @errorDetails,
        updated_at = @updatedAt
    WHERE id = @id
  `,
  ).run({
    id: input.id,
    status: input.status,
    completedAt: now,
    cronTimezone: input.cronTimezone ?? "server local time",
    contextSyncMode: input.contextSyncMode ?? null,
    contextFetchedCount: input.contextFetchedCount ?? 0,
    contextIndexedWorkItemCount: input.contextIndexedWorkItemCount ?? 0,
    contextIndexedChunkCount: input.contextIndexedChunkCount ?? 0,
    contextCreatedCount: input.contextCreatedCount ?? 0,
    contextUpdatedCount: input.contextUpdatedCount ?? 0,
    contextUnchangedCount: input.contextUnchangedCount ?? 0,
    contextInactiveCount: input.contextInactiveCount ?? 0,
    contextSkippedEmptyCount: input.contextSkippedEmptyCount ?? 0,
    knowledgeBaseId: input.knowledgeBaseId ?? null,
    knowledgeSourceWorkItemCount: input.knowledgeSourceWorkItemCount ?? 0,
    knowledgeCompileMode: input.knowledgeCompileMode ?? null,
    knowledgeCompileStatus: input.knowledgeCompileStatus ?? "failed",
    knowledgeCompileSkippedReason: input.knowledgeCompileSkippedReason ?? null,
    errorDetails: input.errorDetails ?? null,
    updatedAt: now,
  });
}

export function getLatestContextAutoUpdateRun() {
  const db = getDatabase();
  ensureContextAutoUpdateRunColumns(db);
  const row = db.prepare(
    `
    SELECT id, project_id, azure_project_id, azure_project_name, azure_organization_url,
           cron_expression, cron_timezone, context_work_item_types, context_states, status, started_at, completed_at,
           context_sync_mode,
           context_fetched_count, context_indexed_work_item_count, context_indexed_chunk_count,
           context_created_count, context_updated_count, context_unchanged_count, context_inactive_count,
           context_skipped_empty_count,
           knowledge_base_id, knowledge_source_work_item_count,
           knowledge_compile_mode, knowledge_compile_status, knowledge_compile_skipped_reason,
           error_details
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
    cronTimezone: row.cron_timezone ?? "server local time",
    workItemTypes: parseStringArray(row.context_work_item_types),
    states: parseStringArray(row.context_states),
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    contextSyncMode: row.context_sync_mode,
    contextFetchedCount: row.context_fetched_count,
    contextIndexedWorkItemCount: row.context_indexed_work_item_count,
    contextIndexedChunkCount: row.context_indexed_chunk_count,
    contextCreatedCount: row.context_created_count,
    contextUpdatedCount: row.context_updated_count,
    contextUnchangedCount: row.context_unchanged_count,
    contextInactiveCount: row.context_inactive_count,
    contextSkippedEmptyCount: row.context_skipped_empty_count,
    knowledgeBaseId: row.knowledge_base_id,
    knowledgeSourceWorkItemCount: row.knowledge_source_work_item_count,
    knowledgeCompileMode: row.knowledge_compile_mode,
    knowledgeCompileStatus: row.knowledge_compile_status ?? "pending",
    knowledgeCompileSkippedReason: row.knowledge_compile_skipped_reason,
    errorDetails: row.error_details,
  };
}

function ensureContextAutoUpdateRunColumns(db: ReturnType<typeof getDatabase>) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(context_auto_update_runs)").all() as Array<{ name: string }>).map((column) => column.name),
  );

  if (!columns.has("cron_timezone")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN cron_timezone TEXT NOT NULL DEFAULT 'server local time'");
  }
  if (!columns.has("context_work_item_types")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_work_item_types TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("context_states")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_states TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns.has("context_sync_mode")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_sync_mode TEXT");
  }
  if (!columns.has("context_created_count")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_created_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("context_updated_count")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_updated_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("context_unchanged_count")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_unchanged_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("context_inactive_count")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_inactive_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("context_skipped_empty_count")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN context_skipped_empty_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.has("knowledge_compile_mode")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN knowledge_compile_mode TEXT");
  }
  if (!columns.has("knowledge_compile_status")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN knowledge_compile_status TEXT NOT NULL DEFAULT 'pending'");
  }
  if (!columns.has("knowledge_compile_skipped_reason")) {
    db.exec("ALTER TABLE context_auto_update_runs ADD COLUMN knowledge_compile_skipped_reason TEXT");
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
