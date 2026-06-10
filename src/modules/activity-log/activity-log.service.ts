import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";
import type { DashboardRecentActivity } from "@/types/dashboard";
import type { ActivityLogActionOption, ActivityLogResult } from "@/types/activity-log";

type ScopeFilter = {
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

function scopeParams(scope?: ProjectScope): ScopeFilter {
  if (!scope) return { projectId: null, azureProjectId: null };
  const validated = assertProjectScope(scope);
  return {
    projectId: validated.projectId,
    azureProjectId: validated.azureProjectId,
  };
}

function scopeWhere() {
  return `(@projectId IS NULL OR project_id = @projectId)
    AND (@azureProjectId IS NULL OR azure_project_id = @azureProjectId)`;
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
// dropdown never loses options while the user is filtering).
function getAvailableActions(scopeFilter: ScopeFilter): ActivityLogActionOption[] {
  const rows = getDatabase()
    .prepare(`SELECT DISTINCT action FROM audit_logs WHERE ${scopeWhere()}`)
    .all(scopeFilter) as ActionRow[];

  const groups = new Set<string>();
  for (const row of rows) {
    const group = row.action.split(".")[0];
    if (group) groups.add(group);
  }

  return [...groups]
    .sort()
    .map((value) => ({ value, label: formatActionGroupLabel(value) }));
}

export function getActivityLog(input: ActivityLogInput): ActivityLogResult {
  const db = getDatabase();
  const scopeFilter = scopeParams(input.scope);
  const limit = clampLimit(input.limit);

  const where: string[] = [scopeWhere()];
  const params: Record<string, unknown> = { ...scopeFilter };

  const term = (input.search ?? "").trim();
  if (term) {
    params.q = `%${escapeLike(term)}%`;
    where.push(
      `(message LIKE @q ESCAPE '\\'
        OR action LIKE @q ESCAPE '\\'
        OR IFNULL(entity_id, '') LIKE @q ESCAPE '\\'
        OR IFNULL(entity_type, '') LIKE @q ESCAPE '\\'
        OR IFNULL(actor, '') LIKE @q ESCAPE '\\')`,
    );
  }

  const groups = (input.groups ?? []).map((group) => group.trim()).filter(Boolean);
  if (groups.length) {
    const clauses = groups.map((group, index) => {
      params[`grpPfx${index}`] = `${escapeLike(group)}.%`;
      params[`grpEq${index}`] = group;
      return `(action LIKE @grpPfx${index} ESCAPE '\\' OR action = @grpEq${index})`;
    });
    where.push(`(${clauses.join(" OR ")})`);
  }

  if (input.from) {
    params.fromTs = `${input.from}T00:00:00.000Z`;
    where.push(`created_at >= @fromTs`);
  }
  if (input.to) {
    params.toTs = `${addOneDayUtc(input.to)}T00:00:00.000Z`;
    where.push(`created_at < @toTs`);
  }

  params.queryLimit = limit + 1;

  const rows = db
    .prepare(
      `SELECT id, project_id, azure_project_id, azure_project_name, azure_organization_url,
              entity_type, entity_id, action, status, actor, message, details_json, created_at, updated_at
       FROM audit_logs
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT @queryLimit`,
    )
    .all(params) as RecentActivityRow[];

  const visible = rows.slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    items: visible.map(mapRow),
    hasMore: rows.length > limit,
    availableActions: getAvailableActions(scopeFilter),
  };
}
