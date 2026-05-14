import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";
import type { DashboardAnalytics } from "@/types/dashboard";

type ScopeFilter = {
  projectId: string | null;
  azureProjectId: string | null;
};

type CountRow = { count: number };
type AvgRow = { average: number | null };
type BreakdownRow = { name: string | null; value: number };
type ActivityRow = { day: string; workflow: string; value: number };
type RecentActivityRow = {
  id: string;
  action: string;
  status: string;
  message: string;
  azure_project_name: string | null;
  created_at: string;
};

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

function getAverage(sql: string, params: ScopeFilter) {
  return (getDatabase().prepare(sql).get(params) as AvgRow | undefined)?.average ?? null;
}

function formatDayLabel(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function buildRecentDays() {
  const days: Array<{ day: string; label: string }> = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    const day = date.toISOString().slice(0, 10);
    days.push({ day, label: formatDayLabel(day) });
  }
  return days;
}

function normalizeStatus(value: string | null) {
  if (!value) return "Unknown";
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function getDashboardAnalytics(input: { scope?: ProjectScope }): DashboardAnalytics {
  const db = getDatabase();
  const params = scopeParams(input.scope);
  const where = scopeWhere();

  const indexedWorkItems = getCount(
    `SELECT COUNT(*) AS count FROM azure_devops_work_items WHERE ${where}`,
    params,
  );
  const contextChunks = getCount(
    `SELECT COUNT(*) AS count FROM document_chunks WHERE ${where}`,
    params,
  );
  const requirementRuns = getCount(
    `SELECT COUNT(*) AS count FROM requirement_analysis_runs WHERE ${where}`,
    params,
  );
  const generatedCases = getCount(
    `SELECT COUNT(*) AS count FROM generated_test_cases WHERE ${where}`,
    params,
  );
  const coverageReviews = getCount(
    `SELECT COUNT(*) AS count FROM existing_test_case_review_runs WHERE ${where}`,
    params,
  );
  const publishAttempts = getCount(
    `SELECT COUNT(*) AS count FROM azure_devops_test_case_push_runs WHERE ${where}`,
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
  const averageLlmDuration = getAverage(
    `SELECT AVG(duration_ms) AS average FROM llm_request_logs WHERE ${where}`,
    params,
  );

  const workItemStates = db
    .prepare(
      `SELECT COALESCE(NULLIF(state, ''), 'Unknown') AS name, COUNT(*) AS value
       FROM azure_devops_work_items
       WHERE ${where}
       GROUP BY COALESCE(NULLIF(state, ''), 'Unknown')
       ORDER BY value DESC
       LIMIT 8`,
    )
    .all(params) as BreakdownRow[];

  const llmProviderStatus = db
    .prepare(
      `SELECT provider || ' / ' || status AS name, COUNT(*) AS value
       FROM llm_request_logs
       WHERE ${where}
       GROUP BY provider, status
       ORDER BY value DESC
       LIMIT 10`,
    )
    .all(params) as BreakdownRow[];

  const auditStatus = db
    .prepare(
      `SELECT status AS name, COUNT(*) AS value
       FROM audit_logs
       WHERE ${where}
       GROUP BY status
       ORDER BY value DESC`,
    )
    .all(params) as BreakdownRow[];

  const publishOutcomes = db
    .prepare(
      `SELECT push_status AS name, COUNT(*) AS value
       FROM azure_devops_test_case_push_runs
       WHERE ${where}
       GROUP BY push_status
       ORDER BY value DESC`,
    )
    .all(params) as BreakdownRow[];

  const activityRows = db
    .prepare(
      `
      SELECT date(created_at) AS day, 'Requirement' AS workflow, COUNT(*) AS value
      FROM requirement_analysis_runs
      WHERE ${where} AND created_at >= date('now', '-13 days')
      GROUP BY date(created_at)
      UNION ALL
      SELECT date(created_at) AS day, 'Test cases' AS workflow, COUNT(*) AS value
      FROM test_case_generation_runs
      WHERE ${where} AND created_at >= date('now', '-13 days')
      GROUP BY date(created_at)
      UNION ALL
      SELECT date(created_at) AS day, 'Coverage' AS workflow, COUNT(*) AS value
      FROM existing_test_case_review_runs
      WHERE ${where} AND created_at >= date('now', '-13 days')
      GROUP BY date(created_at)
      UNION ALL
      SELECT date(created_at) AS day, 'Publish' AS workflow, COUNT(*) AS value
      FROM azure_devops_test_case_push_runs
      WHERE ${where} AND created_at >= date('now', '-13 days')
      GROUP BY date(created_at)
      ORDER BY day ASC
      `,
    )
    .all(params) as ActivityRow[];

  const recentActivity = db
    .prepare(
      `SELECT id, action, status, message, azure_project_name, created_at
       FROM audit_logs
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT 8`,
    )
    .all(params) as RecentActivityRow[];

  const activityByDay = buildRecentDays().map((day) => {
    const rows = activityRows.filter((row) => row.day === day.day);
    return {
      day: day.label,
      Requirement: rows.find((row) => row.workflow === "Requirement")?.value ?? 0,
      "Test cases": rows.find((row) => row.workflow === "Test cases")?.value ?? 0,
      Coverage: rows.find((row) => row.workflow === "Coverage")?.value ?? 0,
      Publish: rows.find((row) => row.workflow === "Publish")?.value ?? 0,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    kpis: {
      indexedWorkItems,
      contextChunks,
      requirementRuns,
      generatedCases,
      coverageReviews,
      publishAttempts,
      llmSuccessRate: llmRequests ? Math.round((llmSuccesses / llmRequests) * 100) : 0,
      averageLlmDurationMs: averageLlmDuration ? Math.round(averageLlmDuration) : 0,
    },
    charts: {
      activityByDay,
      workItemStates: workItemStates.map((row) => ({ name: row.name ?? "Unknown", value: row.value })),
      llmProviderStatus: llmProviderStatus.map((row) => ({ name: row.name ?? "Unknown", value: row.value })),
      auditStatus: auditStatus.map((row) => ({ name: normalizeStatus(row.name), value: row.value })),
      publishOutcomes: publishOutcomes.map((row) => ({ name: normalizeStatus(row.name), value: row.value })),
    },
    recentActivity: recentActivity.map((row) => ({
      id: row.id,
      action: row.action,
      status: normalizeStatus(row.status),
      message: row.message,
      projectName: row.azure_project_name,
      createdAt: row.created_at,
    })),
  };
}
