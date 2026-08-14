import "server-only";

import { writeAuditLogTransactional } from "@/modules/audit/audit.service";
import { enqueueJob } from "@/modules/jobs/job-queue.service";
import { resolveJiraSyncPrincipalAccessToken } from "@/modules/auth/jira-connection.service";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { IntegrationError, type IntegrationErrorCode } from "../core/integration-error";
import type { Requirement } from "../core/integration-types";
import { JiraCloudAdapter } from "./jira-cloud-adapter";
import type { JiraSyncFields, JiraSyncValue } from "./jira-sync-conflict";
import { reconcileJiraMapping } from "./jira-reconciliation.service";
import {
  claimNextJiraSyncOperation, completeJiraSyncOperation, failJiraSyncOperation,
  type ClaimedJiraSyncOperation,
} from "./jira-sync-operation.service";

type FieldMapping = { localField: LocalField; jiraField: string };
type StatusMapping = { localStatus: string; jiraStatus: string };
type LocalField = "title" | "description" | "acceptanceCriteria" | "state" | "priority" | "tags";
type SyncDirection = "jira_to_itestflow" | "itestflow_to_jira" | "two_way";
export const JIRA_SYNC_OPERATIONS = "jira_sync_operations";
type ProjectConfig = {
  project_id: string; provider_project_id: string; provider_project_key: string; provider_project_name: string;
  provider_site_id: string; provider_site_url: string; direction: SyncDirection;
  field_mapping_json: string; status_mapping_json: string;
};
type LocalIssue = {
  id: string; title: string; description: string | null; acceptance_criteria: string | null;
  state: string | null; priority: number | null; tags: string | null;
};

export async function runJiraProjectReconciliation(input: {
  workspaceId: string; projectId: string; actor: string; issueKeys?: string[]; indexContext?: boolean; operationId?: string;
}): Promise<{ issueCount: number; operationCount: number }> {
  const project = await loadProjectConfig(input.workspaceId, input.projectId);
  const fieldMappings = parseArray<FieldMapping>(project.field_mapping_json, "Jira field mappings");
  const statusMappings = parseArray<StatusMapping>(project.status_mapping_json, "Jira status mappings");
  const principal = await resolveJiraSyncPrincipalAccessToken(input.workspaceId);
  const adapter = new JiraCloudAdapter({
    cloudId: project.provider_site_id, siteUrl: project.provider_site_url, accessToken: principal.accessToken,
    fieldMapping: {
      acceptanceCriteriaFieldId: fieldMappings.find((item) => item.localField === "acceptanceCriteria")?.jiraField,
    },
  }, {
    jiraProjectId: project.provider_project_id,
    jiraProjectKey: project.provider_project_key,
    jiraProjectName: project.provider_project_name,
  });
  if (input.operationId) {
    const operationCount = await drainOperations({
      workspaceId: input.workspaceId, projectId: input.projectId, operationId: input.operationId,
      actor: input.actor, adapter, fieldMappings, statusMappings,
    });
    return { issueCount: 0, operationCount };
  }
  const issueKeys = unique((input.issueKeys ?? []).map((value) => value.trim()).filter(Boolean));
  const remoteIssues = issueKeys.length
    ? await adapter.fetchWorkItemsByIds({ projectId: project.provider_project_id, workItemIds: issueKeys })
    : await adapter.fetchWorkItems({ projectId: project.provider_project_id, limit: 1000 });

  for (const remote of remoteIssues) {
    const local = await findOrCreateLocalIssue(project, remote);
    const jiraIssueId = rawText(remote, "id") ?? remote.id;
    const mapping = await sqlGet<{ id: string; status: string }>(
      `INSERT INTO jira_sync_mappings (
         id, workspace_id, project_id, jira_issue_id, jira_issue_key, local_entity_type,
         local_entity_id, direction, status, last_remote_updated_at, created_at, updated_at
       ) VALUES (
         @id, @workspaceId, @projectId, @jiraIssueId, @jiraIssueKey, 'work_item',
         @localEntityId, @direction, 'active', @lastRemoteUpdatedAt, @now, @now
       )
       ON CONFLICT (workspace_id, project_id, jira_issue_id) DO UPDATE SET
         jira_issue_key = excluded.jira_issue_key, direction = excluded.direction,
         last_remote_updated_at = excluded.last_remote_updated_at, updated_at = excluded.updated_at
       RETURNING id, status`,
      {
        id: createId("jiramap"), workspaceId: input.workspaceId, projectId: project.project_id,
        jiraIssueId, jiraIssueKey: remote.id, localEntityId: local.id, direction: project.direction,
        lastRemoteUpdatedAt: remote.updatedDate ?? null, now: nowIso(),
      },
    );
    if (!mapping || mapping.status !== "active") continue;
    const states = await sqlAll<{ field_name: string; baseline_json: string | null }>(
      `SELECT field_name, baseline_json FROM jira_sync_field_states WHERE mapping_id = @mappingId`,
      { mappingId: mapping.id },
    );
    const persisted = new Map(states.map((state) => [state.field_name, decode(state.baseline_json)]));
    const localFields: JiraSyncFields = {};
    const remoteFields: JiraSyncFields = {};
    const baseline: JiraSyncFields = {};
    for (const field of fieldMappings) {
      const localValue = readLocal(local, field.localField);
      const remoteValue = readRemote(remote, field, statusMappings);
      localFields[field.localField] = localValue;
      remoteFields[field.localField] = remoteValue;
      baseline[field.localField] = persisted.has(field.localField) ? persisted.get(field.localField) : remoteValue;
    }
    await reconcileJiraMapping({
      workspaceId: input.workspaceId, mappingId: mapping.id, actor: input.actor,
      baseline, local: localFields, remote: remoteFields,
    });
  }

  const operationCount = await drainOperations({
    workspaceId: input.workspaceId, projectId: input.projectId, operationId: input.operationId, actor: input.actor, adapter, fieldMappings, statusMappings,
  });
  if (input.indexContext) {
    const contextAdapter = {
      fetchWorkItems: async (request: Parameters<JiraCloudAdapter["fetchWorkItems"]>[0]) =>
        (await adapter.fetchWorkItems(request)).map((issue) => toLocalRequirement(issue, fieldMappings, statusMappings)),
    };
    await indexAzureWorkItemsAsProjectContext({
      scope: {
        projectId: project.project_id,
        azureProjectId: project.provider_project_id,
        azureProjectName: project.provider_project_name,
        azureOrganizationUrl: project.provider_site_url,
      },
      actor: input.actor,
      adapter: contextAdapter,
      workItemTypes: [],
      states: [],
      allowEmptyFilters: true,
      mode: "incremental",
      limit: 1000,
    });
  }
  return { issueCount: remoteIssues.length, operationCount };
}

export async function retireJiraIssueMapping(input: {
  workspaceId: string; projectId: string; issueKey: string; actor: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    const mapping = await sqlGet<{ id: string; local_entity_id: string }>(
      `SELECT id, local_entity_id FROM jira_sync_mappings
       WHERE workspace_id = @workspaceId AND project_id = @projectId AND jira_issue_key = @issueKey
       FOR UPDATE`,
      { workspaceId: input.workspaceId, projectId: input.projectId, issueKey: input.issueKey }, client,
    );
    if (!mapping) return;
    const now = nowIso();
    await sqlRun(
      `UPDATE azure_devops_work_items SET sync_status = 'inactive', last_synced_at = @now, updated_at = @now
       WHERE id = @localId AND project_id = @projectId`,
      { localId: mapping.local_entity_id, projectId: input.projectId, now }, client,
    );
    await sqlRun(
      `UPDATE jira_sync_operations SET status = 'failed', error_code = 'integration_not_found',
         processing_started_at = NULL, updated_at = @now
       WHERE mapping_id = @mappingId AND status IN ('pending', 'processing')`,
      { mappingId: mapping.id, now }, client,
    );
    await sqlRun(
      `UPDATE jira_sync_mappings SET status = 'paused', updated_at = @now WHERE id = @mappingId`,
      { mappingId: mapping.id, now }, client,
    );
    await writeAuditLogTransactional({
      workspaceId: input.workspaceId, projectId: input.projectId, entityType: "jira_issue", entityId: input.issueKey,
      action: "jira.sync.issue_deleted", status: "Success", actor: input.actor,
      message: "A deleted Jira issue was retired from synchronization.",
    }, client);
  });
}

async function loadProjectConfig(workspaceId: string, projectId: string): Promise<ProjectConfig> {
  const row = await sqlGet<ProjectConfig>(
    `SELECT p.id AS project_id, p.provider_project_id, p.provider_project_key, p.provider_project_name,
            w.provider_site_id, w.provider_site_url, c.direction, c.field_mapping_json, c.status_mapping_json
     FROM projects p
     JOIN workspaces w ON w.id = p.workspace_id AND w.status = 'active' AND w.provider_id = 'jira-cloud'
     JOIN jira_project_sync_configs c ON c.workspace_id = p.workspace_id AND c.project_id = p.id AND c.status = 'active'
     WHERE p.id = @projectId AND p.workspace_id = @workspaceId AND p.provider_id = 'jira-cloud' AND p.status = 'active'`,
    { workspaceId, projectId },
  );
  if (!row) throw new Error("Active Jira synchronization is not configured for this project.");
  return row;
}

async function findOrCreateLocalIssue(project: ProjectConfig, remote: Requirement): Promise<LocalIssue> {
  const existing = await sqlGet<LocalIssue>(
    `SELECT id, title, description, acceptance_criteria, state, priority, tags
     FROM azure_devops_work_items WHERE project_id = @projectId AND azure_work_item_id = @issueKey`,
    { projectId: project.project_id, issueKey: remote.id },
  );
  if (existing) return existing;
  const now = nowIso();
  const inserted = await sqlGet<LocalIssue>(
    `INSERT INTO azure_devops_work_items (
       id, project_id, azure_project_id, azure_project_name, azure_organization_url,
       azure_work_item_id, work_item_type, title, description, acceptance_criteria,
       state, assigned_to, priority, tags, area_path, iteration_path, raw_json,
       created_date, updated_date, last_synced_at, sync_status, created_at, updated_at
     ) VALUES (
       @id, @projectId, @providerProjectId, @providerProjectName, @siteUrl,
       @issueKey, @workItemType, @title, @description, @acceptanceCriteria,
       @state, @assignedTo, @priority, @tags, @areaPath, @iterationPath, @rawJson,
       @createdDate, @updatedDate, @now, 'active', @now, @now
     )
     ON CONFLICT (project_id, azure_work_item_id) DO NOTHING
     RETURNING id, title, description, acceptance_criteria, state, priority, tags`,
    {
      id: createId("awi"), projectId: project.project_id, providerProjectId: project.provider_project_id,
      providerProjectName: project.provider_project_name, siteUrl: project.provider_site_url, issueKey: remote.id,
      workItemType: remote.workItemType, title: remote.title, description: remote.description ?? null,
      acceptanceCriteria: remote.acceptanceCriteria ?? null, state: remote.state ?? null,
      assignedTo: remote.assignedTo ?? null, priority: remote.priority ?? null,
      tags: remote.tags?.join("; ") ?? null, areaPath: remote.areaPath ?? null,
      iterationPath: remote.iterationPath ?? null, rawJson: JSON.stringify(remote.raw ?? {}),
      createdDate: remote.createdDate ?? null, updatedDate: remote.updatedDate ?? null, now,
    },
  );
  if (inserted) return inserted;
  const raced = await sqlGet<LocalIssue>(
    `SELECT id, title, description, acceptance_criteria, state, priority, tags
     FROM azure_devops_work_items WHERE project_id = @projectId AND azure_work_item_id = @issueKey`,
    { projectId: project.project_id, issueKey: remote.id },
  );
  if (!raced) throw new Error("The Jira work item mirror could not be created.");
  return raced;
}

async function drainOperations(input: {
  workspaceId: string; projectId: string; operationId?: string; actor: string; adapter: JiraCloudAdapter;
  fieldMappings: FieldMapping[]; statusMappings: StatusMapping[];
}): Promise<number> {
  let completed = 0;
  for (let index = 0; index < 1000; index += 1) {
    const operation = await claimNextJiraSyncOperation(input.workspaceId, input.projectId, input.operationId);
    if (!operation) return completed;
    try {
      const context = await sqlGet<{ jira_issue_key: string; local_entity_id: string }>(
        `SELECT jira_issue_key, local_entity_id FROM jira_sync_mappings
         WHERE id = @mappingId AND workspace_id = @workspaceId`,
        { mappingId: operation.mappingId, workspaceId: input.workspaceId },
      );
      if (!context) throw new Error("The Jira sync mapping disappeared during operation processing.");
      const field = input.fieldMappings.find((mapping) => mapping.localField === operation.field);
      if (!field) throw new Error("The Jira sync operation field is no longer configured.");
      if (operation.operation === "pull") {
        await applyLocalPull(context.local_entity_id, field.localField, operation.target);
      } else {
        await applyRemotePush(input.adapter, context.jira_issue_key, field, operation, input.statusMappings);
      }
      await completeJiraSyncOperation({ operationId: operation.id, actor: input.actor });
      completed += 1;
    } catch (error) {
      const failure = await failJiraSyncOperation({ operationId: operation.id, errorCode: errorCode(error) });
      if (failure.retry) {
        if (input.operationId) throw new Error("The exact Jira sync operation remains pending for retry.");
        await enqueueJob({
          jobType: JIRA_SYNC_OPERATIONS, workspaceId: input.workspaceId, projectId: input.projectId,
          payload: { projectId: input.projectId, operationId: operation.id }, dedupeKey: `${JIRA_SYNC_OPERATIONS}:${operation.id}`,
          runAfter: failure.runAfter, maxAttempts: 5, createdByUserId: null,
        });
        return completed;
      }
    }
  }
  throw new Error("Jira synchronization exceeded the safe operation limit.");
}

async function applyLocalPull(localId: string, field: LocalField, target: unknown) {
  const now = nowIso();
  const params = { localId, target: encodeLocal(field, target), now };
  const statements: Record<LocalField, string> = {
    title: "UPDATE azure_devops_work_items SET title = @target, updated_at = @now WHERE id = @localId",
    description: "UPDATE azure_devops_work_items SET description = @target, updated_at = @now WHERE id = @localId",
    acceptanceCriteria: "UPDATE azure_devops_work_items SET acceptance_criteria = @target, updated_at = @now WHERE id = @localId",
    state: "UPDATE azure_devops_work_items SET state = @target, updated_at = @now WHERE id = @localId",
    priority: "UPDATE azure_devops_work_items SET priority = @target, updated_at = @now WHERE id = @localId",
    tags: "UPDATE azure_devops_work_items SET tags = @target, updated_at = @now WHERE id = @localId",
  };
  if (await sqlRun(statements[field], params) !== 1) throw new Error("The local Jira mirror could not be updated.");
}

async function applyRemotePush(
  adapter: JiraCloudAdapter, issueKey: string, field: FieldMapping,
  operation: ClaimedJiraSyncOperation, statuses: StatusMapping[],
) {
  if (field.localField === "state") {
    const localStatus = String(operation.target ?? "");
    const jiraStatus = statuses.find((status) => sameText(status.localStatus, localStatus))?.jiraStatus;
    if (!jiraStatus) throw new Error("The local status is not mapped to a Jira status.");
    await adapter.transitionIssue({ issueKey, statusName: jiraStatus });
    return;
  }
  await adapter.updateIssueFields({ issueKey, fields: { [field.jiraField]: encodeJira(field.localField, operation.target) } });
}

function readLocal(row: LocalIssue, field: LocalField): JiraSyncValue | undefined {
  if (field === "acceptanceCriteria") return row.acceptance_criteria;
  if (field === "tags") return row.tags ? row.tags.split(";").map((tag) => tag.trim()).filter(Boolean) : [];
  return row[field];
}
function readRemote(remote: Requirement, mapping: FieldMapping, statuses: StatusMapping[]): JiraSyncValue | undefined {
  if (mapping.localField === "state") {
    const state = remote.state ?? null;
    return statuses.find((status) => sameText(status.jiraStatus, state))?.localStatus ?? state;
  }
  if (mapping.localField === "acceptanceCriteria") return syncValue(rawField(remote, mapping.jiraField) ?? remote.acceptanceCriteria ?? null);
  if (mapping.localField === "tags") return remote.tags ?? [];
  return remote[mapping.localField] ?? null;
}
function toLocalRequirement(remote: Requirement, mappings: FieldMapping[], statuses: StatusMapping[]): Requirement {
  const local = { ...remote };
  for (const mapping of mappings) {
    const value = readRemote(remote, mapping, statuses);
    if (mapping.localField === "acceptanceCriteria") local.acceptanceCriteria = value == null ? undefined : String(value);
    else if (mapping.localField === "tags") local.tags = Array.isArray(value) ? value : [];
    else if (mapping.localField === "priority") local.priority = typeof value === "number" ? value : undefined;
    else if (mapping.localField === "state") local.state = value == null ? undefined : String(value);
    else if (mapping.localField === "description") local.description = value == null ? undefined : String(value);
    else if (mapping.localField === "title") local.title = value == null ? "Untitled Jira issue" : String(value);
  }
  return local;
}
function rawField(remote: Requirement, field: string): unknown {
  const raw = record(remote.raw); return record(raw?.fields)?.[field];
}
function rawText(remote: Requirement, field: string): string | undefined {
  const value = record(remote.raw)?.[field]; return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
function encodeLocal(field: LocalField, value: unknown): unknown {
  if (field === "tags") return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("; ") : null;
  if (field === "priority") return typeof value === "number" ? value : value === null ? null : Number(value);
  return value === undefined ? null : value;
}
function encodeJira(field: LocalField, value: unknown): unknown {
  if (field === "description") return { type: "doc", version: 1, content: [{ type: "paragraph", content: value == null ? [] : [{ type: "text", text: String(value) }] }] };
  if (field === "priority") return value == null ? null : { id: String(value) };
  return value === undefined ? null : value;
}
function parseArray<T>(value: string, label: string): T[] {
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed as T[]; } catch { /* fixed error below */ }
  throw new Error(`${label} are invalid.`);
}
function decode(value: string | null): JiraSyncValue | undefined {
  if (value === null) return null;
  try { const parsed = JSON.parse(value); return record(parsed)?.$itestflow === "absent" ? undefined : syncValue(parsed); }
  catch { throw new Error("A Jira synchronization baseline is invalid."); }
}
function errorCode(error: unknown): IntegrationErrorCode { return error instanceof IntegrationError ? error.code : "integration_unknown"; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function syncValue(value: unknown): JiraSyncValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error("A Jira synchronization field value is invalid.");
}
function sameText(left: string, right: unknown) { return typeof right === "string" && left.toLocaleLowerCase() === right.toLocaleLowerCase(); }
function unique<T>(values: T[]) { return [...new Set(values)]; }
