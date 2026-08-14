import "server-only";

import { createId, nowIso, sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";

export async function upsertJiraProjectMapping(input: {
  workspaceId: string;
  actorUserId: string;
  providerId: "jira-cloud";
  jiraProjectId: string;
  jiraProjectKey: string;
  jiraProjectName: string;
}): Promise<string> {
  const now = nowIso();
  const row = await sqlGet<{ id: string }>(
    `INSERT INTO projects (
       id, azure_project_id, azure_project_name, azure_organization_url,
       name, status, workspace_id, provider_id,
       provider_project_id, provider_project_key, provider_project_name, created_at, updated_at
     )
     SELECT @id, @jiraProjectId, @jiraProjectName, w.provider_site_url,
            @jiraProjectName, 'active', w.id, @providerId,
            @jiraProjectId, @jiraProjectKey, @jiraProjectName, @now, @now
     FROM workspaces w
     JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = @actorUserId
       AND m.status = 'active' AND m.role IN ('owner', 'admin')
     WHERE w.id = @workspaceId AND w.provider_id = 'jira-cloud' AND w.status = 'active'
     ON CONFLICT (workspace_id, provider_id, provider_project_id) WHERE workspace_id IS NOT NULL AND provider_project_id IS NOT NULL
     DO UPDATE SET
       provider_project_key = excluded.provider_project_key,
       provider_project_name = excluded.provider_project_name,
       azure_project_name = excluded.azure_project_name,
       name = excluded.name,
       status = 'active',
       updated_at = excluded.updated_at
     RETURNING id`,
    {
      id: createId("project"), workspaceId: input.workspaceId, actorUserId: input.actorUserId, providerId: input.providerId,
      jiraProjectId: input.jiraProjectId.trim(), jiraProjectKey: input.jiraProjectKey.trim(),
      jiraProjectName: input.jiraProjectName.trim(), now,
    },
  );
  if (!row) throw new Error("Jira project mapping is not available for this workspace.");
  return row.id;
}

export type JiraFieldMappingInput = { localField: string; jiraField: string };
export type JiraStatusMappingInput = { localStatus: string; jiraStatus: string };

export async function storeJiraProjectSyncConfig(input: {
  workspaceId: string;
  projectId: string;
  actorUserId: string;
  direction: "jira_to_itestflow" | "itestflow_to_jira" | "two_way";
  fieldMappings: JiraFieldMappingInput[];
  statusMappings: JiraStatusMappingInput[];
}): Promise<void> {
  const workspaceId = input.workspaceId.trim();
  const projectId = input.projectId.trim();
  const actorUserId = input.actorUserId.trim();
  const directions = new Set(["jira_to_itestflow", "itestflow_to_jira", "two_way"]);
  const fieldMappings = normalizeMappings(input.fieldMappings, "localField", "jiraField", "Jira field mapping");
  const statusMappings = normalizeMappings(input.statusMappings, "localStatus", "jiraStatus", "Jira status mapping");
  if (fieldMappings.some((mapping) => !isSupportedJiraFieldMapping(mapping))) throw new Error("Jira field mapping is invalid.");
  if (!workspaceId || !projectId || !actorUserId || !directions.has(input.direction)) {
    throw new Error("Jira synchronization configuration is invalid.");
  }
  const now = nowIso();
  const row = await sqlGet<{ id: string }>(
    `INSERT INTO jira_project_sync_configs (
       id, workspace_id, project_id, direction, field_mapping_json, status_mapping_json, status, created_at, updated_at
     )
     SELECT @id, p.workspace_id, p.id, @direction, @fieldMappingJson, @statusMappingJson, 'active', @now, @now
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @actorUserId
       AND wm.status = 'active' AND wm.role IN ('owner', 'admin')
     WHERE p.workspace_id = @workspaceId AND p.id = @projectId
       AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     ON CONFLICT (workspace_id, project_id) DO UPDATE SET
       direction = excluded.direction, field_mapping_json = excluded.field_mapping_json,
       status_mapping_json = excluded.status_mapping_json, status = 'active', updated_at = excluded.updated_at
     RETURNING id`,
    {
      id: createId("jirasyncconfig"), workspaceId, projectId, actorUserId, direction: input.direction,
      fieldMappingJson: JSON.stringify(fieldMappings), statusMappingJson: JSON.stringify(statusMappings), now,
    },
  );
  if (!row) throw new Error("Jira synchronization configuration is not authorized for this project.");
}

function isSupportedJiraFieldMapping(mapping: JiraFieldMappingInput) {
  const allowed: Record<string, RegExp> = {
    title: /^summary$/i,
    description: /^description$/i,
    acceptanceCriteria: /^customfield_[0-9]+$/i,
    state: /^status$/i,
    priority: /^priority$/i,
    tags: /^labels$/i,
  };
  return allowed[mapping.localField]?.test(mapping.jiraField) === true;
}

function normalizeMappings<T extends Record<K, string>, K extends string>(
  values: T[], left: K, right: K, label: string,
): T[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50) throw new Error(`${label} is invalid.`);
  const normalized = values.map((value) => ({ ...value, [left]: value[left]?.trim(), [right]: value[right]?.trim() })) as T[];
  if (normalized.some((value) => !value[left] || !value[right] || value[left].length > 100 || value[right].length > 100)) {
    throw new Error(`${label} is invalid.`);
  }
  for (const key of [left, right]) {
    const unique = new Set(normalized.map((value) => value[key].toLocaleLowerCase()));
    if (unique.size !== normalized.length) throw new Error(`${label} contains duplicate values.`);
  }
  return normalized;
}

type OverviewProjectRow = {
  id: string; provider_project_id: string; provider_project_key: string; provider_project_name: string;
  backend_type: "plain_jira" | "xray_cloud" | "zephyr_scale" | null; backend_status: string | null; region: string | null;
  direction: "jira_to_itestflow" | "itestflow_to_jira" | "two_way" | null;
  field_mapping_json: string | null; status_mapping_json: string | null;
};

export async function getJiraIntegrationOverview(input: { workspaceId: string; actorUserId: string }) {
  const workspaceId = input.workspaceId.trim();
  const actorUserId = input.actorUserId.trim();
  if (!workspaceId || !actorUserId) throw new Error("Jira integration access is invalid.");
  const anchor = await sqlGet<{
    workspace_id: string; workspace_name: string; provider_site_name: string; provider_site_url: string;
    role: "owner" | "admin" | "member"; connection_status: string;
  }>(
    `SELECT w.id AS workspace_id, w.name AS workspace_name, w.provider_site_name, w.provider_site_url,
            wm.role, COALESCE(jc.status, 'not_connected') AS connection_status
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = @actorUserId AND wm.status = 'active'
     LEFT JOIN jira_connections jc ON jc.workspace_id = w.id AND jc.user_id = @actorUserId
     WHERE w.id = @workspaceId AND w.provider_id = 'jira-cloud' AND w.status = 'active'`,
    { workspaceId, actorUserId },
  );
  if (!anchor) throw new Error("Jira Cloud is not available for this workspace.");

  const projects = await sqlAll<OverviewProjectRow>(
    `SELECT p.id, p.provider_project_id, p.provider_project_key, p.provider_project_name,
            b.backend_type, b.status AS backend_status, b.region,
            s.direction, s.field_mapping_json, s.status_mapping_json
     FROM projects p
     LEFT JOIN jira_artifact_backend_configs b ON b.workspace_id = p.workspace_id AND b.project_id = p.id
     LEFT JOIN jira_project_sync_configs s ON s.workspace_id = p.workspace_id AND s.project_id = p.id AND s.status = 'active'
     WHERE p.workspace_id = @workspaceId AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     ORDER BY p.provider_project_name ASC`,
    { workspaceId },
  );
  const mappings = await sqlAll<{
    id: string; project_id: string; jira_issue_key: string; local_entity_type: string; local_entity_id: string;
    direction: string; status: string; last_synced_at: string | null; updated_at: string;
  }>(
    `SELECT id, project_id, jira_issue_key, local_entity_type, local_entity_id, direction, status, last_synced_at, updated_at
     FROM jira_sync_mappings WHERE workspace_id = @workspaceId ORDER BY updated_at DESC LIMIT 50`, { workspaceId },
  );
  const conflicts = await sqlAll<{
    mapping_id: string; project_id: string; field_name: string; local_json: string | null; remote_json: string | null; updated_at: string;
  }>(
    `SELECT f.mapping_id, m.project_id, f.field_name, f.local_json, f.remote_json, f.updated_at
     FROM jira_sync_field_states f JOIN jira_sync_mappings m ON m.id = f.mapping_id
     WHERE m.workspace_id = @workspaceId AND f.status = 'conflict' ORDER BY f.updated_at DESC LIMIT 50`, { workspaceId },
  );
  const traceLinks = await sqlAll<{
    id: string; project_id: string; local_artifact_type: string; local_artifact_id: string;
    remote_artifact_id: string | null; remote_url: string | null; backend_type: string; status: string; updated_at: string;
  }>(
    `SELECT id, project_id, local_artifact_type, local_artifact_id, remote_artifact_id, remote_url, backend_type, status, updated_at
     FROM jira_artifact_links WHERE workspace_id = @workspaceId ORDER BY updated_at DESC LIMIT 50`, { workspaceId },
  );

  return {
    providerId: "jira-cloud" as const,
    role: anchor.role,
    workspace: { id: anchor.workspace_id, name: anchor.workspace_name, siteName: anchor.provider_site_name, siteUrl: anchor.provider_site_url },
    connection: { status: anchor.connection_status },
    projects: projects.map((project) => ({
      id: project.id, providerProjectId: project.provider_project_id, key: project.provider_project_key, name: project.provider_project_name,
      backend: project.backend_type ? { type: project.backend_type, status: project.backend_status, region: project.region } : null,
      sync: project.direction ? {
        direction: project.direction,
        fieldMappings: parseMappingJson<JiraFieldMappingInput>(project.field_mapping_json),
        statusMappings: parseMappingJson<JiraStatusMappingInput>(project.status_mapping_json),
      } : null,
    })),
    mappings: mappings.map((mapping) => ({
      id: mapping.id, projectId: mapping.project_id, jiraIssueKey: mapping.jira_issue_key,
      localEntityType: mapping.local_entity_type, localEntityId: mapping.local_entity_id,
      direction: mapping.direction, status: mapping.status, lastSyncedAt: mapping.last_synced_at, updatedAt: mapping.updated_at,
    })),
    conflicts: conflicts.map((conflict) => ({
      mappingId: conflict.mapping_id, projectId: conflict.project_id, field: conflict.field_name,
      localValue: parseJsonValue(conflict.local_json), remoteValue: parseJsonValue(conflict.remote_json), updatedAt: conflict.updated_at,
    })),
    traceLinks: traceLinks.map((link) => ({
      id: link.id, projectId: link.project_id, localArtifactType: link.local_artifact_type,
      localArtifactId: link.local_artifact_id, remoteArtifactId: link.remote_artifact_id,
      remoteUrl: link.remote_url, backendType: link.backend_type, status: link.status, updatedAt: link.updated_at,
    })),
  };
}

function parseMappingJson<T>(value: string | null): T[] {
  if (!value) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Jira synchronization configuration metadata is invalid."); }
  if (!Array.isArray(parsed)) throw new Error("Jira synchronization configuration metadata is invalid.");
  return parsed as T[];
}

function parseJsonValue(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
}
