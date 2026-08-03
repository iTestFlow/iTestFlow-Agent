import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import type { DashboardRecentActivity } from "@/types/dashboard";
import type { ActivityLogActionOption, ActivityLogResult } from "@/types/activity-log";

type ScopeFilter = {
  workspaceId: string;
  projectId: string | null;
  azureProjectId: string | null;
};

type RecentActivityRow = {
  id: string;
  project_id: string | null;
  azure_project_id: string | null;
  action: string;
  status: string;
  actor: string | null;
  message: string;
  azure_project_name: string | null;
  azure_organization_url: string | null;
  entity_type: string | null;
  entity_id: string | null;
  details_json: string | null;
  created_at: string;
  updated_at: string;
};

type ActionRow = { action: string };

export type ActivityLogInput = {
  workspaceId: string;
  scope?: ProjectScope;
  search?: string;
  groups?: string[];
  from?: string;
  to?: string;
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Known action groups whose friendly label differs from the generic formatter.
const ACTION_GROUP_LABELS: Record<string, string> = {
  azure_devops: "Azure DevOps",
  rag: "RAG",
};

function scopeParams(workspaceId: string, scope?: ProjectScope): ScopeFilter {
  if (!scope) return { workspaceId, projectId: null, azureProjectId: null };
  const validated = assertProjectScope(scope);
  return {
    workspaceId,
    projectId: validated.projectId,
    azureProjectId: validated.azureProjectId,
  };
}

function scopeWhere() {
  return `workspace_id = @workspaceId
    AND (@projectId::text IS NULL OR project_id = @projectId)
    AND (@azureProjectId::text IS NULL OR azure_project_id = @azureProjectId)`;
}

function clampLimit(value: number | undefined) {
  if (!value) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_LIMIT);
}

function normalizeStatus(value: string | null) {
  if (!value) return "Unknown";
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function parseDetailsJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

// Escape LIKE wildcards (% _) and the escape character itself so user input is matched literally.
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Half-open upper bound: the picked "to" day is inclusive because we compare `created_at < (to + 1 day)`.
function addOneDayUtc(day: string) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function formatActionGroupLabel(group: string) {
  const override = ACTION_GROUP_LABELS[group];
  if (override) return override;
  const words = group.split(/[_\s]+/).filter(Boolean).join(" ");
  if (!words) return group;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function mapRow(row: RecentActivityRow): DashboardRecentActivity {
  return {
    id: row.id,
    action: row.action,
    status: normalizeStatus(row.status),
    message: row.message,
    projectName: row.azure_project_name,
    createdAt: row.created_at,
    audit: {
      id: row.id,
      projectId: row.project_id,
      azureProjectId: row.azure_project_id,
      azureProjectName: row.azure_project_name,
      azureOrganizationUrl: row.azure_organization_url,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      status: row.status,
      actor: row.actor,
      message: row.message,
      detailsJson: parseDetailsJson(row.details_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

// Distinct action groups present in the scope (ignores search/group/date filters so the
// dropdown never loses options while the user is filtering). UNION (not UNION ALL)
// dedupes across the two sources.
async function getAvailableActions(scopeFilter: ScopeFilter): Promise<ActivityLogActionOption[]> {
  const rows = await sqlAll<ActionRow>(
    `SELECT action FROM audit_logs WHERE ${scopeWhere()}
     UNION
     SELECT event_type AS action FROM project_knowledge_log WHERE ${scopeWhere()}`,
    scopeFilter,
  );

  const groups = new Set<string>();
  for (const row of rows) {
    const group = row.action.split(".")[0];
    if (group) groups.add(group);
  }

  return [...groups]
    .sort()
    .map((value) => ({ value, label: formatActionGroupLabel(value) }));
}

export async function getActivityLog(input: ActivityLogInput): Promise<ActivityLogResult> {
  const scopeFilter = scopeParams(input.workspaceId, input.scope);
  const limit = clampLimit(input.limit);

  // Two sources merge into one feed: audit_logs (user actions, with actor attribution)
  // and project_knowledge_log (knowledge/context operational events — lint results,
  // embedding failures, exports — written by the system without an actor). The Knowledge
  // Hub panel that used to display the latter was removed; this page is now its only
  // surface. Each source gets its own WHERE list because their searchable columns differ.
  const auditWhere: string[] = [scopeWhere()];
  const knowledgeWhere: string[] = [scopeWhere()];
  const params: Record<string, unknown> = { ...scopeFilter };

  const term = (input.search ?? "").trim();
  if (term) {
    params.q = `%${escapeLike(term)}%`;
    auditWhere.push(
      `(message LIKE @q ESCAPE '\\'
        OR action LIKE @q ESCAPE '\\'
        OR COALESCE(entity_id, '') LIKE @q ESCAPE '\\'
        OR COALESCE(entity_type, '') LIKE @q ESCAPE '\\'
        OR COALESCE(actor, '') LIKE @q ESCAPE '\\')`,
    );
    // Knowledge events carry no actor or entity columns; title/message/event_type is
    // their whole searchable surface.
    knowledgeWhere.push(
      `(title LIKE @q ESCAPE '\\'
        OR message LIKE @q ESCAPE '\\'
        OR event_type LIKE @q ESCAPE '\\')`,
    );
  }

  const groups = (input.groups ?? []).map((group) => group.trim()).filter(Boolean);
  if (groups.length) {
    const auditClauses: string[] = [];
    const knowledgeClauses: string[] = [];
    groups.forEach((group, index) => {
      params[`grpPfx${index}`] = `${escapeLike(group)}.%`;
      params[`grpEq${index}`] = group;
      auditClauses.push(`(action LIKE @grpPfx${index} ESCAPE '\\' OR action = @grpEq${index})`);
      knowledgeClauses.push(`(event_type LIKE @grpPfx${index} ESCAPE '\\' OR event_type = @grpEq${index})`);
    });
    auditWhere.push(`(${auditClauses.join(" OR ")})`);
    knowledgeWhere.push(`(${knowledgeClauses.join(" OR ")})`);
  }

  if (input.from) {
    params.fromTs = `${input.from}T00:00:00.000Z`;
    auditWhere.push(`created_at >= @fromTs`);
    knowledgeWhere.push(`created_at >= @fromTs`);
  }
  if (input.to) {
    params.toTs = `${addOneDayUtc(input.to)}T00:00:00.000Z`;
    auditWhere.push(`created_at < @toTs`);
    knowledgeWhere.push(`created_at < @toTs`);
  }

  params.queryLimit = limit + 1;

  // Each branch is parenthesized so it can pre-sort and pre-limit (filters first, then
  // LIMIT — limiting before filtering would drop matching rows); the outer ORDER/LIMIT
  // merges the two newest-first streams while keeping the limit+1 hasMore convention.
  // details_json for knowledge rows is string-composed rather than json_build_object so
  // one historically malformed metadata row degrades to a raw string in parseDetailsJson
  // instead of failing the whole query.
  const rows = await sqlAll<RecentActivityRow>(
    `SELECT * FROM (
       (SELECT id, project_id, azure_project_id, azure_project_name, azure_organization_url,
               entity_type, entity_id, action, status, actor, message, details_json, created_at, updated_at
        FROM audit_logs
        WHERE ${auditWhere.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT @queryLimit)
       UNION ALL
       (SELECT id, project_id, azure_project_id, azure_project_name, azure_organization_url,
               'knowledge_event' AS entity_type, NULL::text AS entity_id,
               event_type AS action, severity AS status, NULL::text AS actor,
               title || ' — ' || message AS message,
               CASE WHEN source_ids <> '[]'
                    THEN '{"sourceIds":' || source_ids || ',"metadata":' || COALESCE(metadata_json, 'null') || '}'
                    ELSE metadata_json END AS details_json,
               created_at, created_at AS updated_at
        FROM project_knowledge_log
        WHERE ${knowledgeWhere.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT @queryLimit)
     ) merged
     ORDER BY created_at DESC
     LIMIT @queryLimit`,
    params,
  );

  const visible = rows.slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    items: visible.map(mapRow),
    hasMore: rows.length > limit,
    availableActions: await getAvailableActions(scopeFilter),
  };
}
