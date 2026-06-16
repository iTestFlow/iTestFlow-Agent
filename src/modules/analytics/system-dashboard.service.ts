import "server-only";

import {
  PUBLISH_WORKFLOW_TYPES,
  workflowLabels,
  workflowTypeValues,
  type WorkflowType,
} from "@/modules/analytics/analytics-config";
import { calculateElapsedMinutes } from "@/modules/analytics/analytics-metrics";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getDatabase } from "@/modules/shared/infrastructure/database/db";
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

type AuditRow = {
  action: string;
  status: string;
  details_json: string | null;
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

export function getSystemDashboardAnalytics(input: SystemDashboardInput): SystemDashboardAnalytics {
  const scope = assertProjectScope(input.scope);
  const dateRange = resolveDateRange(input.filters);
  const selectedWorkflows = input.filters?.workflowTypes?.length
    ? input.filters.workflowTypes
    : [...workflowTypeValues];
  const userId = input.filters?.userId?.trim() || null;
  const rows = loadAnalyticsRows({
    scope,
    from: dateRange.from,
    toExclusive: addDays(dateRange.to, 1),
    workflowTypes: selectedWorkflows,
    userId,
  });
  const completedRows = rows.filter((row) => row.status === "completed" || row.status === "published");
  const totalSavedMinutes = sum(rows, "estimated_saved_minutes");
  // Acceptance is only meaningful for workflows with a select/publish step; conversational
  // and estimation workflows generate output with nothing to "accept" and would otherwise
  // drag the rate toward 0.
  const acceptanceRows = rows.filter((row) => PUBLISH_WORKFLOW_TYPES.includes(row.workflow_type));
  const generatedOutputs = sum(acceptanceRows, "items_generated");
  const acceptedOutputs = acceptanceRows.reduce((total, row) => total + acceptedCount(row), 0);
  const highRiskIssues = sum(rows, "high_risk_items_found");
  const testCasesPublished = rows
    .filter((row) => row.workflow_type === "test_case_design" || row.workflow_type === "test_gap_analysis")
    .reduce((total, row) => total + row.items_published, 0);
  const workflowSavings = buildWorkflowSavings(rows);
  const mostValuable = [...workflowSavings].sort((left, right) => right.totalSavedMinutes - left.totalSavedMinutes)[0];
  const requirementQuality = buildRequirementQuality(rows);
  const testDesignCoverage = buildTestDesignCoverage(rows);
  const knowledgeHub = buildKnowledgeHub(scope, rows);
  const adoAutomation = buildAdoAutomation(scope, dateRange.from, addDays(dateRange.to, 1), rows);
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
      highRiskIssuesFound: metric(highRiskIssues, true, "Critical and high-risk findings detected before delivery."),
      testCasesPublished: metric(testCasesPublished, true, "Generated test cases successfully published to Azure DevOps."),
      acceptanceRate: metric(
        generatedOutputs ? round((acceptedOutputs / generatedOutputs) * 100, 1) : null,
        generatedOutputs > 0,
        "Across publish-oriented workflows: published outputs are counted first; selected outputs are used when publishing does not apply.",
      ),
      mostValuableWorkflow: mostValuable?.totalSavedMinutes
        ? mostValuable.workflow
        : null,
      manualActionsAvoided: sum(rows, "manual_actions_avoided"),
    },
    workflowSavings: {
      rows: workflowSavings,
      trend: buildSavingsTrend(rows),
    },
    requirementQuality,
    testDesignCoverage,
    knowledgeHub,
    adoAutomation,
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

  return getDatabase().prepare(
    `SELECT id, user_id, workflow_type, work_item_id, started_at, generation_completed_at,
            completed_at, status,
            manual_baseline_minutes, actual_duration_minutes, estimated_saved_minutes,
            items_generated, items_selected, items_edited, items_published, items_rejected,
            high_risk_items_found, medium_risk_items_found, low_risk_items_found,
            manual_actions_avoided, used_knowledge_context, metadata_json
     FROM analytics_workflow_runs
     WHERE project_id = @projectId AND azure_project_id = @azureProjectId
       AND started_at >= @from AND started_at < @to
       AND workflow_type IN (${workflowParameters.join(", ")})
       AND (@userId IS NULL OR user_id = @userId)
     ORDER BY started_at DESC`,
  ).all(params) as AnalyticsRow[];
}

function buildWorkflowSavings(rows: AnalyticsRow[]): WorkflowSavingsRow[] {
  return workflowTypeValues.map((workflowType) => {
    const workflowRows = rows.filter((row) => row.workflow_type === workflowType);
    const generated = sum(workflowRows, "items_generated");
    const accepted = workflowRows.reduce((total, row) => total + acceptedCount(row), 0);
    const durations = workflowRows
      .map(effectiveDurationMinutes)
      .filter((value): value is number => value !== null);
    const totalSavedMinutes = sum(workflowRows, "estimated_saved_minutes");
    return {
      workflowType,
      workflow: workflowLabels[workflowType],
      runs: workflowRows.length,
      manualBaselineMinutes: round(average(workflowRows.map((row) => row.manual_baseline_minutes)) ?? 0, 1),
      actualAverageMinutes: durations.length ? round(average(durations) ?? 0, 1) : null,
      averageSavedMinutes: workflowRows.length ? round(totalSavedMinutes / workflowRows.length, 1) : 0,
      totalSavedMinutes: round(totalSavedMinutes, 1),
      acceptanceRate: PUBLISH_WORKFLOW_TYPES.includes(workflowType) && generated
        ? round((accepted / generated) * 100, 1)
        : null,
    };
  });
}

function effectiveDurationMinutes(row: AnalyticsRow) {
  if (row.actual_duration_minutes !== null) return row.actual_duration_minutes;
  if (!row.generation_completed_at) return null;
  return calculateElapsedMinutes(row.started_at, row.generation_completed_at);
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

function buildRequirementQuality(rows: AnalyticsRow[]): SystemDashboardAnalytics["requirementQuality"] {
  const requirementRows = rows.filter((row) => row.workflow_type === "requirements_analysis");
  const scores = metadataNumbers(requirementRows, ["requirement", "testabilityScore"]);
  const categoryCounts = mergeMetadataCounts(requirementRows, ["requirement", "issueCategories"]);
  const totalGapsFound = sum(requirementRows, "items_generated");
  const criticalHighRequirements = requirementRows.filter(
    (row) => row.high_risk_items_found > 0,
  ).length;
  const sortedCategories = sortCounts(categoryCounts);

  return {
    requirementsAnalyzed: requirementRows.length,
    averageTestabilityScore: scores.length ? round(average(scores) ?? 0, 1) : null,
    requirementsWithCriticalHighGaps: criticalHighRequirements,
    totalGapsFound,
    averageRisksPerRequirement: requirementRows.length ? round(totalGapsFound / requirementRows.length, 1) : null,
    mostCommonIssueCategory: sortedCategories[0]?.name ?? null,
    issueCategories: sortedCategories,
  };
}

function buildTestDesignCoverage(rows: AnalyticsRow[]): SystemDashboardAnalytics["testDesignCoverage"] {
  const designRows = rows.filter((row) => row.workflow_type === "test_case_design");
  const coverageRows = rows.filter((row) => row.workflow_type === "test_gap_analysis");
  const combined = [...designRows, ...coverageRows];
  const scores = metadataNumbers(coverageRows, ["coverage", "score"]);
  const categories = mergeMetadataCounts(combined, ["testDesign", "categories"]);
  const missingCoverage = metadataNumbers(coverageRows, ["coverage", "missingAreas"]);
  const weakDuplicate = metadataNumbers(coverageRows, ["coverage", "weakDuplicateCases"]);
  const uniqueStories = distinct(combined.map((row) => row.work_item_id).filter(isString));

  return {
    testCasesGenerated: sum(combined, "items_generated"),
    testCasesPublished: sum(combined, "items_published"),
    averageTestCasesPerStory: uniqueStories.length
      ? round(sum(combined, "items_generated") / uniqueStories.length, 1)
      : null,
    accepted: combined.reduce((total, row) => total + acceptedCount(row), 0),
    edited: sum(combined, "items_edited"),
    rejected: sum(combined, "items_rejected"),
    estimatedHoursSaved: round(sum(combined, "estimated_saved_minutes") / 60, 1),
    storiesReviewedForCoverage: coverageRows.length,
    averageCoverageScore: scores.length ? round(average(scores) ?? 0, 1) : null,
    missingCoverageAreas: sumValues(missingCoverage),
    weakDuplicateCases: sumValues(weakDuplicate),
    coverageCategories: sortCounts(categories),
  };
}

function buildKnowledgeHub(
  scope: ProjectScope,
  rows: AnalyticsRow[],
): SystemDashboardAnalytics["knowledgeHub"] {
  const db = getDatabase();
  const params = { projectId: scope.projectId, azureProjectId: scope.azureProjectId };
  const indexed = db.prepare(
    `SELECT COUNT(*) AS count, MAX(updated_at) AS last_refresh
     FROM azure_devops_work_items
     WHERE project_id = @projectId AND azure_project_id = @azureProjectId AND sync_status = 'active'`,
  ).get(params) as { count: number; last_refresh: string | null };
  const knowledge = db.prepare(
    `SELECT COUNT(*) AS count FROM project_knowledge_entries
     WHERE project_id = @projectId AND azure_project_id = @azureProjectId`,
  ).get(params) as { count: number };
  const lint = db.prepare(
    `SELECT COUNT(*) AS count FROM project_knowledge_lint_issues
     WHERE project_id = @projectId AND azure_project_id = @azureProjectId AND status = 'open'`,
  ).get(params) as { count: number };
  const knowledgeRuns = rows.filter((row) => row.workflow_type === "knowledge_indexing");
  const aiRows = rows.filter((row) => isAiWorkflow(row.workflow_type));
  const contextRows = aiRows.filter((row) => Boolean(row.used_knowledge_context));
  const references = new Map<string, number>();
  for (const row of rows) {
    const contextItems = metadataArray(row, ["contextUsed"]);
    for (const item of contextItems) references.set(item, (references.get(item) ?? 0) + 1);
  }

  return {
    indexedWorkItems: indexed.count,
    knowledgeItems: knowledge.count,
    lastRefresh: indexed.last_refresh,
    failedIndexingRuns: knowledgeRuns.filter((row) => row.status === "failed").length,
    aiRunsUsingContext: contextRows.length,
    contextUsageRate: aiRows.length ? round((contextRows.length / aiRows.length) * 100, 1) : null,
    mostReferencedContextItems: [...references.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 8)
      .map(([name, value]) => ({ name, value })),
    staleKnowledgeWarnings: lint.count,
  };
}

function buildAdoAutomation(
  scope: ProjectScope,
  from: string,
  toExclusive: string,
  rows: AnalyticsRow[],
): SystemDashboardAnalytics["adoAutomation"] {
  const audits = getDatabase().prepare(
    `SELECT action, status, details_json FROM audit_logs
     WHERE project_id = @projectId AND azure_project_id = @azureProjectId
       AND created_at >= @from AND created_at < @to
       AND (action LIKE 'azure_devops.%' OR action LIKE 'test_coverage_matrix.%')`,
  ).all({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    from: localDayStartIso(from),
    to: localDayStartIso(toExclusive),
  }) as AuditRow[];
  // Audits that produced at least some output (full or partial success) — used only to
  // tally what was actually created/linked, since a partial failure still creates items.
  const producing = audits.filter((row) => row.status === "Success" || row.status === "Partial failure");
  // Headline metrics treat the three outcomes as disjoint: only full "Success" counts
  // toward the rate, only "Failed" counts as a failed operation, and "Partial failure"
  // is neutral — so a partial can no longer inflate the success rate or be double-counted.
  const fullySuccessful = audits.filter((row) => row.status === "Success");
  const failed = audits.filter((row) => row.status === "Failed");
  let commentsPublished = 0;
  let testCasesCreated = 0;
  let workItemsLinked = 0;
  let bulkTasksCreated = 0;
  let suiteMigrationsCompleted = 0;

  for (const audit of producing) {
    const details = parseJson(audit.details_json);
    if (audit.action === "azure_devops.push_requirement_comment") commentsPublished += audit.status === "Success" ? 1 : 0;
    if (audit.action === "azure_devops.publish_test_cases" || audit.action === "test_coverage_matrix.publish_suggested_additions") {
      const results = arrayValue(details?.results);
      testCasesCreated += results.filter((result) => recordBoolean(result, "create", "success")).length;
      workItemsLinked += results.filter((result) => recordBoolean(result, "link", "success")).length;
    }
    if (audit.action === "azure_devops.bulk_create_tasks") {
      bulkTasksCreated += arrayValue(details?.created).length;
    }
    if (audit.action === "azure_devops.test_suite_migration" && audit.status === "Success") {
      suiteMigrationsCompleted += 1;
    }
  }

  return {
    commentsPublished,
    testCasesCreated,
    workItemsLinked,
    suiteMigrationsCompleted,
    bulkTasksCreated,
    manualActionsAvoided: sum(rows, "manual_actions_avoided"),
    publishSuccessRate: audits.length ? round((fullySuccessful.length / audits.length) * 100, 1) : null,
    failedOperations: failed.length,
  };
}

function buildAdoption(rows: AnalyticsRow[]): SystemDashboardAnalytics["adoption"] {
  const users = distinct(rows.map((row) => row.user_id));
  const byWorkflow = new Map<WorkflowType, number>();
  rows.forEach((row) => byWorkflow.set(row.workflow_type, (byWorkflow.get(row.workflow_type) ?? 0) + 1));
  const top = [...byWorkflow.entries()].sort((left, right) => right[1] - left[1])[0];
  // Rejected items vs generated items — one consistent unit so the rate stays <= 100%.
  const rejected = sum(rows, "items_rejected");
  const generated = sum(rows, "items_generated");

  return {
    activeUsers: users.length,
    workflowRuns: rows.length,
    runsPerUser: users.length ? round(rows.length / users.length, 1) : null,
    mostUsedFeature: top ? workflowLabels[top[0]] : null,
    rejectionRate: generated ? round((rejected / generated) * 100, 1) : null,
    topWorkflowByAdoption: top ? workflowLabels[top[0]] : null,
  };
}

function resolveDateRange(filters: SystemDashboardInput["filters"]) {
  const preset = filters?.datePreset ?? "30d";
  if (preset === "custom" && filters?.from && filters.to) {
    return { preset, from: filters.from, to: filters.to };
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

function acceptedCount(row: AnalyticsRow) {
  return row.items_published > 0 ? row.items_published : row.items_selected;
}

function metric(value: number | null, available: boolean, supportingText: string) {
  return { value, available, supportingText };
}

function sum<T extends Record<string, unknown>>(rows: T[], key: keyof T) {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function average(values: number[]) {
  return values.length ? sumValues(values) / values.length : null;
}

function sumValues(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
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

function metadataNumbers(rows: AnalyticsRow[], path: string[]) {
  return rows
    .map((row) => nestedValue(parseJson(row.metadata_json), path))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function mergeMetadataCounts(rows: AnalyticsRow[], path: string[]) {
  const result = new Map<string, number>();
  for (const row of rows) {
    const value = nestedValue(parseJson(row.metadata_json), path);
    if (!isRecord(value)) continue;
    for (const [name, count] of Object.entries(value)) {
      const numeric = Number(count);
      if (!Number.isFinite(numeric)) continue;
      result.set(name, (result.get(name) ?? 0) + numeric);
    }
  }
  return result;
}

function sortCounts(counts: Map<string, number>) {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, value]) => ({ name, value }));
}

function metadataArray(row: AnalyticsRow, path: string[]) {
  const value = nestedValue(parseJson(row.metadata_json), path);
  return Array.isArray(value) ? value.filter(isString) : [];
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function parseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function arrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function recordBoolean(value: Record<string, unknown>, parent: string, child: string) {
  const nested = value[parent];
  return isRecord(nested) && nested[child] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAiWorkflow(workflowType: WorkflowType) {
  return workflowType !== "suite_migration" && workflowType !== "bulk_task_creation" && workflowType !== "knowledge_indexing";
}
