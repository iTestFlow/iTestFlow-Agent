import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";
import type { DashboardAnalytics } from "@/types/dashboard";

type ScopeFilter = {
  projectId: string | null;
  azureProjectId: string | null;
};

type CountRow = { count: number };
type MessageRow = { message: string };
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

const DEFAULT_RECENT_ACTIVITY_LIMIT = 8;
const MAX_RECENT_ACTIVITY_LIMIT = 100;

function scopeParams(scope?: ProjectScope): ScopeFilter {
  if (!scope) return { projectId: null, azureProjectId: null };
  const validated = assertProjectScope(scope);
  return {
    projectId: validated.projectId,
    azureProjectId: validated.azureProjectId,
  };
}

function scopeWhere(alias = "") {
  const prefix = alias ? `${alias}.` : "";
  return `(@projectId IS NULL OR ${prefix}project_id = @projectId)
    AND (@azureProjectId IS NULL OR ${prefix}azure_project_id = @azureProjectId)`;
}

function getCount(sql: string, params: ScopeFilter) {
  return (getDatabase().prepare(sql).get(params) as CountRow | undefined)?.count ?? 0;
}

function sumGeneratedCaseAuditMessages(params: ScopeFilter) {
  const rows = getDatabase()
    .prepare(
      `SELECT message
       FROM audit_logs
       WHERE ${scopeWhere()}
         AND status = 'Success'
         AND action IN ('test_case_generation.run', 'test_case_generation.manual_complete')`,
    )
    .all(params) as MessageRow[];

  return rows.reduce((total, row) => {
    const match = row.message.match(/Generated\s+(\d+)/i);
    return total + (match ? Number(match[1]) : 0);
  }, 0);
}

function normalizeStatus(value: string | null) {
  if (!value) return "Unknown";
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function clampRecentActivityLimit(value: number | undefined) {
  if (!value) return DEFAULT_RECENT_ACTIVITY_LIMIT;
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RECENT_ACTIVITY_LIMIT);
}

function parseDetailsJson(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function getDashboardAnalytics(input: { scope?: ProjectScope; recentActivityLimit?: number }): DashboardAnalytics {
  const db = getDatabase();
  const params = scopeParams(input.scope);
  const where = scopeWhere();
  const recentActivityLimit = clampRecentActivityLimit(input.recentActivityLimit);

  const indexedWorkItems = getCount(
    `SELECT COUNT(*) AS count FROM azure_devops_work_items WHERE ${where}`,
    params,
  );
  const businessRules = getCount(
    `SELECT COUNT(*) AS count FROM project_knowledge_entries WHERE ${where} AND category = 'business_rule'`,
    params,
  );
  const requirementRuns = getCount(
    `SELECT COUNT(*) AS count FROM audit_logs
     WHERE ${where}
       AND status = 'Success'
       AND action IN ('requirement_analysis.run', 'requirement_analysis.manual_complete')`,
    params,
  );
  const generatedCases = sumGeneratedCaseAuditMessages(params);
  const coverageReviews = getCount(
    `SELECT COUNT(*) AS count FROM audit_logs
     WHERE ${where}
       AND status = 'Success'
       AND action IN ('existing_test_case_review.run', 'existing_test_case_review.manual_complete')`,
    params,
  );
  const llmRequests = getCount(
    `SELECT COUNT(*) AS count FROM llm_request_logs WHERE ${where}`,
    params,
  );
  const llmSuccesses = getCount(
    `SELECT COUNT(*) AS count FROM llm_request_logs WHERE ${where} AND status = 'Success'`,
    params,
  );

  const recentActivity = db
    .prepare(
      `SELECT id, project_id, azure_project_id, azure_project_name, azure_organization_url,
              entity_type, entity_id, action, status, actor, message, details_json, created_at, updated_at
       FROM audit_logs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT @recentActivityQueryLimit`,
    )
    .all({ ...params, recentActivityQueryLimit: recentActivityLimit + 1 }) as RecentActivityRow[];

  const visibleRecentActivity = recentActivity.slice(0, recentActivityLimit);

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      indexedWorkItems,
      businessRules,
      requirementRuns,
      generatedCases,
      coverageReviews,
      llmSuccessRate: llmRequests ? Math.round((llmSuccesses / llmRequests) * 100) : 0,
    },
    recentActivity: visibleRecentActivity.map((row) => ({
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
    })),
    recentActivityHasMore: recentActivity.length > recentActivityLimit,
  };
}
