import "server-only";

import {
  workflowLabels,
  workflowTypeValues,
  type WorkflowType,
} from "@/modules/analytics/analytics-config";
import { calculateElapsedMinutes } from "@/modules/analytics/analytics-metrics";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import { localDayStartIso, toLocalDayString } from "@/shared/lib/local-day";
import type {
  SystemDashboardAnalytics,
  SystemDashboardDatePreset,
  WorkflowSavingsRow,
} from "@/types/system-dashboard";

type AnalyticsRow = {
  id: string;
  user_id: string;
  workflow_type: WorkflowType;
  work_item_id: string | null;
  started_at: string;
  generation_completed_at: string | null;
  completed_at: string | null;
  status: string;
  manual_baseline_minutes: number;
  actual_duration_minutes: number | null;
  estimated_saved_minutes: number;
  items_generated: number;
  items_selected: number;
  items_edited: number;
  items_published: number;
  items_rejected: number;
  high_risk_items_found: number;
  medium_risk_items_found: number;
  low_risk_items_found: number;
  manual_actions_avoided: number;
  used_knowledge_context: number;
  metadata_json: string | null;
};

export type SystemDashboardInput = {
  scope: ProjectScope;
  filters?: {
    datePreset?: SystemDashboardDatePreset;
    from?: string;
    to?: string;
    workflowTypes?: WorkflowType[];
    userId?: string | null;
  };
};

export async function getSystemDashboardAnalytics(input: SystemDashboardInput): Promise<SystemDashboardAnalytics> {
  const scope = assertProjectScope(input.scope);
  const dateRange = resolveDateRange(input.filters);
  const selectedWorkflows = input.filters?.workflowTypes?.length
    ? input.filters.workflowTypes
    : [...workflowTypeValues];
  const userId = input.filters?.userId?.trim() || null;
  const rows = await loadAnalyticsRows({
    scope,
    from: dateRange.from,
    toExclusive: addDays(dateRange.to, 1),
    workflowTypes: selectedWorkflows,
    userId,
  });
  const completedRows = rows.filter((row) => row.status === "completed" || row.status === "published");
  const totalSavedMinutes = sum(rows, "estimated_saved_minutes");
  const testCasesPublished = rows
    .filter((row) => row.workflow_type === "test_case_design" || row.workflow_type === "test_gap_analysis")
    .reduce((total, row) => total + row.items_published, 0);
  const workflowSavings = buildWorkflowSavings(rows);
  const adoption = buildAdoption(rows);

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      dateRange,
      workflowTypes: selectedWorkflows,
      userId,
    },
    filterMetadata: {
      workflows: workflowTypeValues.map((value) => ({ value, label: workflowLabels[value] })),
      users: distinct(rows.map((row) => row.user_id)).map((value) => ({ value, label: userLabel(value) })),
    },
    overview: {
      estimatedHoursSaved: metric(
        round(totalSavedMinutes / 60, 1),
        true,
        "Estimated from configured manual baselines minus actual elapsed workflow time.",
      ),
      workflowsCompleted: metric(completedRows.length, true, "Completed or published iTestFlow workflow runs."),
      testCasesPublished: metric(testCasesPublished, true, "Generated test cases successfully published to Azure DevOps."),
      manualActionsAvoided: sum(rows, "manual_actions_avoided"),
    },
    workflowSavings: {
      rows: workflowSavings,
      trend: buildSavingsTrend(rows),
    },
    adoption,
    warnings: rows.length
      ? []
      : ["No workflow analytics are available for the selected period. New workflow activity will appear here automatically."],
  };
}

function loadAnalyticsRows(input: {
  scope: ProjectScope;
  from: string;
  toExclusive: string;
  workflowTypes: WorkflowType[];
  userId: string | null;
}) {
  const params: Record<string, unknown> = {
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    from: localDayStartIso(input.from),
    to: localDayStartIso(input.toExclusive),
    userId: input.userId,
  };
  const workflowParameters = input.workflowTypes.map((workflowType, index) => {
    params[`workflow${index}`] = workflowType;
    return `@workflow${index}`;
  });

  return sqlAll<AnalyticsRow>(
    `SELECT id, user_id, workflow_type, work_item_id, started_at, generation_completed_at,
            completed_at, status, manual_baseline_minutes, actual_duration_minutes, estimated_saved_minutes,
            items_generated, items_selected, items_edited, items_published, items_rejected,
            high_risk_items_found, medium_risk_items_found, low_risk_items_found,
            manual_actions_avoided, used_knowledge_context, metadata_json
     FROM analytics_workflow_runs
     WHERE project_id = @projectId AND azure_project_id = @azureProjectId
       AND started_at >= @from AND started_at < @to
       AND workflow_type IN (${workflowParameters.join(", ")})
       AND (@userId::text IS NULL OR user_id = @userId)
     ORDER BY started_at DESC`,
    params,
  );
}

function buildWorkflowSavings(rows: AnalyticsRow[]): WorkflowSavingsRow[] {
  return workflowTypeValues.map((workflowType) => {
    const workflowRows = rows.filter((row) => row.workflow_type === workflowType);
    const durations = workflowRows
      .map(effectiveDurationMinutes)
      .filter((value): value is number => value !== null);
    return {
      workflowType,
      workflow: workflowLabels[workflowType],
      runs: workflowRows.length,
      manualBaselineMinutes: round(average(workflowRows.map((row) => row.manual_baseline_minutes)) ?? 0, 1),
      actualAverageMinutes: durations.length ? round(average(durations) ?? 0, 1) : null,
      totalSavedMinutes: round(sum(workflowRows, "estimated_saved_minutes"), 1),
    };
  });
}

function effectiveDurationMinutes(row: AnalyticsRow) {
  if (row.actual_duration_minutes !== null) return row.actual_duration_minutes;
  if (!row.generation_completed_at) return null;
  return calculateElapsedMinutes(row.started_at, row.generation_completed_at);
}

function average(values: number[]) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function buildSavingsTrend(rows: AnalyticsRow[]) {
  const grouped = new Map<string, { savedHours: number }>();
  for (const row of rows) {
    const date = toLocalDayString(new Date(row.started_at));
    const current = grouped.get(date) ?? { savedHours: 0 };
    current.savedHours += row.estimated_saved_minutes / 60;
    grouped.set(date, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({
      date,
      savedHours: round(values.savedHours, 1),
    }));
}

function buildAdoption(rows: AnalyticsRow[]): SystemDashboardAnalytics["adoption"] {
  const users = distinct(rows.map((row) => row.user_id));
  const byWorkflow = new Map<WorkflowType, number>();
  rows.forEach((row) => byWorkflow.set(row.workflow_type, (byWorkflow.get(row.workflow_type) ?? 0) + 1));
  const top = [...byWorkflow.entries()].sort((left, right) => right[1] - left[1])[0];

  return {
    activeUsers: users.length,
    workflowRuns: rows.length,
    mostUsedFeature: top ? workflowLabels[top[0]] : null,
  };
}

function resolveDateRange(filters: SystemDashboardInput["filters"]) {
  const preset = filters?.datePreset ?? "30d";
  if (preset === "custom" && filters?.from && filters.to) {
    return { preset, from: filters.from, to: filters.to };
  }
  if (preset === "overall") {
    // All-time: bound the lower edge well before any recorded workflow activity.
    return { preset, from: "2000-01-01", to: toLocalDayString(new Date()) };
  }
  const days = preset === "7d" ? 7 : preset === "14d" ? 14 : 30;
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - (days - 1));
  return {
    preset,
    from: toLocalDayString(from),
    to: toLocalDayString(to),
  };
}

function metric(value: number | null, available: boolean, supportingText: string) {
  return { value, available, supportingText };
}

function sum<T extends Record<string, unknown>>(rows: T[], key: keyof T) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function round(value: number, digits: number) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function addDays(value: string, days: number) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + days);
  return toLocalDayString(date);
}

function distinct<T>(values: T[]) {
  return [...new Set(values)];
}

function userLabel(value: string) {
  return value === "local-user" ? "Local user" : value;
}
