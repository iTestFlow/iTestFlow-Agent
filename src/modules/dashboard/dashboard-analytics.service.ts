import "server-only";

import type { IntegrationProvider } from "@/modules/integrations/provider-registry";
import type {
  AzureIteration,
  AzureTestPoint,
  AzureTestResult,
  AzureTestRun,
  Requirement,
  TestSuite,
} from "@/modules/integrations/azure-devops/azure-devops-types";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import type {
  DashboardAnalytics,
  DashboardBugRow,
  DashboardDatePreset,
  DashboardDistributionDatum,
  DashboardFilterMetadata,
  DashboardFilters,
  DashboardReleaseBlocker,
  DashboardRequirementRow,
  DashboardSectionAvailability,
} from "@/types/dashboard";
import {
  buildExecutionRows,
  buildRequirementRows,
  calculateAgingDays,
  calculatePercentage,
  calculateReleaseReadiness,
  classifyBlockerReason,
  DASHBOARD_LIMITS,
  groupDistribution,
  isCovered,
  isOpenBugState,
  isResolvedBugState,
  normalizePriority,
  normalizeSeverity,
  normalizeTestOutcome,
  type DashboardExecutionItem,
} from "./dashboard-metrics";
import { toLocalDayString } from "@/shared/lib/local-day";

export type DashboardAnalyticsInput = {
  scope: ProjectScope;
  filters?: {
    datePreset?: DashboardDatePreset;
    from?: string;
    to?: string;
    testPlanId?: string | null;
    testSuiteIds?: string[];
    areaPath?: string | null;
    iterationPath?: string | null;
    workItemTypes?: string[];
    assignee?: string | null;
  };
  bypassCache?: boolean;
};

type SourceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

type SuiteWithPath = TestSuite & { path: string };
type PointWithSuite = AzureTestPoint & { dashboardSuitePath: string };

const ANALYTICS_CACHE_TTL_MS = 60_000;
const METADATA_CACHE_TTL_MS = 300_000;
const ANALYTICS_CACHE_MAX_ENTRIES = 200;
const METADATA_CACHE_MAX_ENTRIES = 100;
const DEFAULT_REQUIREMENT_TYPES = ["User Story", "Product Backlog Item", "Requirement"];
const analyticsCache = new Map<string, { expiresAt: number; value: DashboardAnalytics }>();
const metadataCache = new Map<string, { expiresAt: number; value: Awaited<ReturnType<typeof loadBaseMetadata>> }>();

export async function getDashboardAnalytics(input: DashboardAnalyticsInput, adapter: IntegrationProvider): Promise<DashboardAnalytics> {
  const scope = assertProjectScope(input.scope);
  const cacheKey = buildCacheKey(scope, input.filters);
  const cached = analyticsCache.get(cacheKey);
  if (!input.bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;

  const metadata = await getCachedMetadata(scope, input.bypassCache, () => loadBaseMetadata(adapter, scope));
  const dateRange = resolveDateRange(input.filters, metadata.iterations.ok ? metadata.iterations.data : []);
  const availableRequirementTypes = metadata.workItemTypes.ok
    ? metadata.workItemTypes.data.filter(isRequirementType)
    : DEFAULT_REQUIREMENT_TYPES;
  const requirementTypes = input.filters?.workItemTypes?.filter((type) => availableRequirementTypes.includes(type));
  const selectedRequirementTypes = requirementTypes?.length ? requirementTypes : availableRequirementTypes.length
    ? availableRequirementTypes
    : DEFAULT_REQUIREMENT_TYPES;

  const plans = metadata.plans.ok ? metadata.plans.data : [];
  const requestedPlanId = input.filters?.testPlanId ?? null;
  const selectedPlanId = requestedPlanId && plans.some((plan) => plan.id === requestedPlanId)
    ? requestedPlanId
    : plans[0]?.id ?? null;
  const suiteResult = selectedPlanId
    ? await capture(() => adapter.fetchTestSuiteTree({ projectId: scope.azureProjectId, testPlanId: selectedPlanId }))
    : ({ ok: true, data: [] } satisfies SourceResult<TestSuite[]>);
  const suites = suiteResult.ok ? flattenSuites(suiteResult.data) : [];
  const requestedSuiteIds = input.filters?.testSuiteIds?.filter((id) => suites.some((suite) => suite.id === id)) ?? [];
  const allSuiteIds = suites.map((suite) => suite.id);
  // With no explicit suite filter the dashboard would otherwise issue one ADO test-point
  // request per suite. Cap the default fan-out to bound cold-load cost on large plans; an
  // explicit suite selection is never capped, and truncation is surfaced as a warning.
  const suitesTruncated = !requestedSuiteIds.length && allSuiteIds.length > DASHBOARD_LIMITS.suites;
  const selectedSuiteIds = requestedSuiteIds.length
    ? requestedSuiteIds
    : allSuiteIds.slice(0, DASHBOARD_LIMITS.suites);

  const filters: DashboardFilters = {
    dateRange,
    testPlanId: selectedPlanId,
    testSuiteIds: requestedSuiteIds,
    areaPath: input.filters?.areaPath ?? null,
    iterationPath: input.filters?.iterationPath ?? null,
    workItemTypes: selectedRequirementTypes,
    assignee: input.filters?.assignee ?? null,
  };

  const [pointsResult, bugsResult, requirementsResult, runsResult] = await Promise.all([
    selectedPlanId && selectedSuiteIds.length
      ? loadTestPoints(adapter, scope.azureProjectId, selectedPlanId, suites, selectedSuiteIds)
      : Promise.resolve({ ok: true, data: [] } satisfies SourceResult<PointWithSuite[]>),
    capture(() => adapter.fetchWorkItems({
      projectId: scope.azureProjectId,
      workItemTypes: ["Bug"],
      areaPath: filters.areaPath ?? undefined,
      iterationPath: filters.iterationPath ?? undefined,
      assignedTo: filters.assignee ?? undefined,
      limit: DASHBOARD_LIMITS.workItems,
    })),
    capture(() => adapter.fetchWorkItems({
      projectId: scope.azureProjectId,
      workItemTypes: selectedRequirementTypes,
      areaPath: filters.areaPath ?? undefined,
      iterationPath: filters.iterationPath ?? undefined,
      assignedTo: filters.assignee ?? undefined,
      limit: DASHBOARD_LIMITS.workItems,
    })),
    selectedPlanId
      ? capture(() => adapter.fetchTestRuns({
          projectId: scope.azureProjectId,
          testPlanId: selectedPlanId,
          limit: DASHBOARD_LIMITS.testRuns,
        }))
      : Promise.resolve({ ok: true, data: [] } satisfies SourceResult<AzureTestRun[]>),
  ]);

  const runsInRange = (runsResult.ok
    ? runsResult.data.filter((run) => isDateInRange(run.completedDate ?? run.startedDate ?? run.createdDate, dateRange.from, dateRange.to))
    : []
  ).sort((a, b) => dateTime(b.completedDate ?? b.startedDate ?? b.createdDate) - dateTime(a.completedDate ?? a.startedDate ?? a.createdDate));
  const resultsResult = runsInRange.length
    ? await loadTestResults(adapter, scope.azureProjectId, runsInRange.slice(0, DASHBOARD_LIMITS.trendRuns))
    : ({ ok: true, data: [] } satisfies SourceResult<AzureTestResult[]>);

  const points = pointsResult.ok ? pointsResult.data : [];
  const bugs = bugsResult.ok ? bugsResult.data : [];
  const requirements = requirementsResult.ok ? requirementsResult.data : [];
  const testResults = resultsResult.ok ? resultsResult.data : [];

  const executionItems = points.map((point) => toExecutionItem(point, adapter, scope));
  const executionRows = buildExecutionRows(executionItems);
  const outcomeCounts = countOutcomes(executionItems);
  const executionTotal = executionItems.length;
  const executionExecuted = outcomeCounts.passed + outcomeCounts.failed + outcomeCounts.blocked + outcomeCounts.skipped;
  const executionPercentage = calculatePercentage(executionExecuted, executionTotal);
  const passRate = calculatePercentage(outcomeCounts.passed, outcomeCounts.passed + outcomeCounts.failed + outcomeCounts.blocked);

  const openBugs = bugs.filter((bug) => isOpenBugState(bug.state));
  const openCriticalBugs = openBugs.filter((bug) => normalizeSeverity(bug.severity) === "Critical");
  const openHighBugs = openBugs.filter((bug) => normalizeSeverity(bug.severity) === "High");
  const retestPending = openBugs.filter((bug) => isResolvedBugState(bug.state));
  const bugRows = buildBugRows(openBugs, requirements, adapter, scope);

  const outcomesByTestCaseId = new Map<string, ReturnType<typeof normalizeTestOutcome>[]>();
  points.forEach((point) => {
    if (!point.testCaseId) return;
    outcomesByTestCaseId.set(point.testCaseId, [
      ...(outcomesByTestCaseId.get(point.testCaseId) ?? []),
      normalizeTestOutcome(point.outcome ?? point.state),
    ]);
  });
  const linkedBugCounts = buildRequirementBugCounts(openBugs);
  const requirementRows = buildRequirementRows(
    requirements.map((requirement) => ({
      id: requirement.id,
      title: requirement.title,
      priority: requirement.priority,
      module: requirement.areaPath,
      acceptanceCriteria: requirement.acceptanceCriteria,
      linkedTestCaseIds: unique([...(requirement.testedByLinks ?? []), ...(requirement.testsLinks ?? [])]),
      openCriticalHighBugCount: linkedBugCounts.get(requirement.id) ?? 0,
      url: buildWorkItemUrl(adapter, scope, requirement.id),
    })),
    outcomesByTestCaseId,
  );
  const coveredRequirements = requirementRows.filter((row) => isCovered(row.coverageStatus)).length;
  const coveragePercentage = calculatePercentage(coveredRequirements, requirementRows.length);
  const highRiskCoverageGaps = requirementRows.filter(
    (row) => ["critical", "high"].includes(row.riskStatus) && row.coverageStatus === "not_covered",
  );

  const latestResultsByTestCase = latestResultsByCase(testResults);
  const blockerRows = executionItems
    .filter((item) => item.outcome === "blocked")
    .map((item) => {
      const result = item.testCaseId ? latestResultsByTestCase.get(item.testCaseId) : undefined;
      const reasonText = [item.reasonText, result?.comment, result?.errorMessage].filter(Boolean).join(" ");
      return {
        id: item.id,
        title: item.title,
        reason: classifyBlockerReason(reasonText),
        ageDays: calculateAgingDays(item.lastRunDate ?? result?.completedDate),
        recommendedAction: classifyBlockerReason(reasonText) === "Unknown"
          ? "Review the latest test run or comment and classify the blocker reason."
          : `Remove the ${classifyBlockerReason(reasonText).toLowerCase()} blocker and re-run the test.`,
        url: item.url ?? null,
      };
    })
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));

  const executionAvailable = Boolean(selectedPlanId && pointsResult.ok && executionTotal > 0);
  const bugsAvailable = bugsResult.ok;
  const coverageAvailable = requirementsResult.ok && requirementRows.length > 0;
  const readiness = calculateReleaseReadiness({
    executionAvailable,
    bugsAvailable,
    coverageAvailable,
    executionPercentage,
    passRate,
    openCriticalBugs: openCriticalBugs.length,
    openHighBugs: openHighBugs.length,
    blockedTests: outcomeCounts.blocked,
    highRiskUncoveredRequirements: highRiskCoverageGaps.length,
    retestPending: retestPending.length,
  });

  const releaseBlockers = buildReleaseBlockers({
    bugs: bugRows.filter((bug) => ["Critical", "High"].includes(bug.severity)),
    blockers: blockerRows,
    requirements: highRiskCoverageGaps,
  });

  const sections = buildSectionAvailability({
    selectedPlanId,
    suites,
    suiteResult,
    pointsResult,
    bugsResult,
    executionTotal,
  });
  const warnings = buildWarnings({
    metadata,
    sections,
    dateRangePreset: filters.dateRange.preset,
    currentSprintResolved: filters.dateRange.preset !== "current_sprint" || Boolean(findCurrentIteration(metadata.iterations.ok ? metadata.iterations.data : [])),
    workItemsTruncated: bugs.length >= DASHBOARD_LIMITS.workItems || requirements.length >= DASHBOARD_LIMITS.workItems,
    runsTruncated: runsResult.ok && runsResult.data.length >= DASHBOARD_LIMITS.testRuns,
    suitesTruncated,
    totalSuites: suites.length,
  });

  const response: DashboardAnalytics = {
    generatedAt: new Date().toISOString(),
    filters,
    filterMetadata: buildFilterMetadata(metadata, suites),
    kpis: {
      testExecutionProgress: metric(executionAvailable, executionExecuted, executionTotal, executionPercentage, `${executionExecuted} of ${executionTotal} test points executed`),
      passRate: metric(executionAvailable, outcomeCounts.passed, outcomeCounts.passed + outcomeCounts.failed + outcomeCounts.blocked, passRate, `${outcomeCounts.passed} passed of ${outcomeCounts.passed + outcomeCounts.failed + outcomeCounts.blocked} evaluated outcomes`),
      openBugs: countMetric(bugsAvailable, openBugs.length, "Current bugs not in a completed or removed state"),
      openCriticalHighBugs: countMetric(bugsAvailable, openCriticalBugs.length + openHighBugs.length, `${openCriticalBugs.length} critical and ${openHighBugs.length} high severity bugs open`),
      requirementsCoverage: metric(coverageAvailable, coveredRequirements, requirementRows.length, coveragePercentage, `${coveredRequirements} of ${requirementRows.length} requirements have linked test cases`),
    },
    testingProgress: {
      statusDistribution: outcomeDistribution(outcomeCounts),
      table: executionRows,
    },
    bugStatus: {
      bySeverity: groupDistribution(openBugs.map((bug) => normalizeSeverity(bug.severity)), ["Critical", "High", "Medium", "Low", "Unknown"]),
      agingBugs: bugRows.slice(0, DASHBOARD_LIMITS.tableRows),
    },
    releaseReadiness: {
      status: readiness.status,
      score: readiness.score,
      summary: readiness.summary,
      reasons: readiness.reasons,
      blockers: releaseBlockers,
    },
    metadata: {
      sections,
      warnings,
    },
  };

  pruneAndSet(analyticsCache, cacheKey, { expiresAt: Date.now() + ANALYTICS_CACHE_TTL_MS, value: response }, ANALYTICS_CACHE_MAX_ENTRIES);
  return response;
}

async function getCachedMetadata(
  scope: ProjectScope,
  bypassCache: boolean | undefined,
  loader: () => ReturnType<typeof loadBaseMetadata>,
) {
  const key = scope.azureProjectId;
  const cached = metadataCache.get(key);
  if (!bypassCache && cached && cached.expiresAt > Date.now()) return cached.value;
  const value = await loader();
  pruneAndSet(metadataCache, key, { expiresAt: Date.now() + METADATA_CACHE_TTL_MS, value }, METADATA_CACHE_MAX_ENTRIES);
  return value;
}

async function loadBaseMetadata(
  adapter: IntegrationProvider,
  scope: ProjectScope,
) {
  const [plans, areas, iterations, users, workItemMetadata] = await Promise.all([
    capture(() => adapter.fetchTestPlans({ projectId: scope.azureProjectId })),
    capture(() => adapter.fetchAreas({ projectId: scope.azureProjectId })),
    capture(() => adapter.fetchIterations({ projectId: scope.azureProjectId })),
    capture(() => adapter.fetchProjectUsers({ projectId: scope.azureProjectId })),
    capture(() => adapter.fetchProjectWorkItemMetadata({ projectId: scope.azureProjectId, includeStates: false })),
  ]);
  return {
    plans,
    areas,
    iterations,
    users,
    workItemTypes: workItemMetadata.ok
      ? ({ ok: true, data: workItemMetadata.data.workItemTypes } as SourceResult<string[]>)
      : ({ ok: false, error: workItemMetadata.error } as SourceResult<string[]>),
  };
}

async function loadTestPoints(
  adapter: IntegrationProvider,
  projectId: string,
  testPlanId: string,
  suites: SuiteWithPath[],
  suiteIds: string[],
): Promise<SourceResult<PointWithSuite[]>> {
  try {
    const selected = suiteIds.map((id) => suites.find((suite) => suite.id === id)).filter(isDefined);
    const batches = await mapWithConcurrency(selected, 4, async (suite) => {
      const points = await adapter.fetchTestPoints({ projectId, testPlanId, testSuiteId: suite.id });
      return points.map((point) => ({ ...point, dashboardSuitePath: suite.path }));
    });
    const uniquePoints = new Map<string, PointWithSuite>();
    batches.flat().forEach((point) => uniquePoints.set(point.id, point));
    return { ok: true, data: [...uniquePoints.values()] };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Azure Test Point fetch failed.") };
  }
}

async function loadTestResults(
  adapter: IntegrationProvider,
  projectId: string,
  runs: AzureTestRun[],
): Promise<SourceResult<AzureTestResult[]>> {
  try {
    const resultSets = await mapWithConcurrency(runs, 4, (run) =>
      adapter.fetchTestResults({ projectId, runId: run.id, limit: DASHBOARD_LIMITS.testResults }),
    );
    return { ok: true, data: resultSets.flat().slice(0, DASHBOARD_LIMITS.testResults) };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Azure Test Result fetch failed.") };
  }
}

function toExecutionItem(
  point: PointWithSuite,
  adapter: IntegrationProvider,
  scope: ProjectScope,
): DashboardExecutionItem {
  return {
    id: point.testCaseId ?? point.id,
    testCaseId: point.testCaseId ?? null,
    title: point.testCaseTitle ?? `Test point ${point.id}`,
    module: point.dashboardSuitePath || point.suiteName || "Unassigned",
    outcome: normalizeTestOutcome(point.outcome ?? point.state),
    owner: point.assignedTo?.displayName ?? point.tester?.displayName ?? null,
    lastRunDate: point.lastRunDate ?? point.lastUpdatedDate ?? null,
    url: point.testCaseId ? buildWorkItemUrl(adapter, scope, point.testCaseId) : null,
  };
}

function buildBugRows(
  bugs: Requirement[],
  requirements: Requirement[],
  adapter: IntegrationProvider,
  scope: ProjectScope,
): DashboardBugRow[] {
  const requirementsById = new Map(requirements.map((requirement) => [requirement.id, requirement]));
  return bugs
    .map((bug) => {
      const linkedId = [...(bug.parentLinks ?? []), ...(bug.relatedLinks ?? [])].find((id) => requirementsById.has(id)) ?? null;
      const linked = linkedId ? requirementsById.get(linkedId) : undefined;
      return {
        id: bug.id,
        title: bug.title,
        severity: normalizeSeverity(bug.severity),
        priority: normalizePriority(bug.priority),
        status: bug.state ?? "Unknown",
        assignee: bug.assignedTo ?? null,
        ageDays: calculateAgingDays(bug.createdDate),
        linkedRequirementId: linkedId,
        linkedRequirementTitle: linked?.title ?? null,
        url: buildWorkItemUrl(adapter, scope, bug.id),
      };
    })
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || (b.ageDays ?? -1) - (a.ageDays ?? -1));
}

function buildRequirementBugCounts(bugs: Requirement[]) {
  const counts = new Map<string, number>();
  bugs
    .filter((bug) => ["Critical", "High"].includes(normalizeSeverity(bug.severity)))
    .forEach((bug) => {
      unique([...(bug.parentLinks ?? []), ...(bug.relatedLinks ?? [])]).forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
    });
  return counts;
}

function buildReleaseBlockers(input: {
  bugs: DashboardBugRow[];
  blockers: Array<{ id: string; title: string; reason: string; ageDays: number | null; recommendedAction: string; url: string | null }>;
  requirements: DashboardRequirementRow[];
}): DashboardReleaseBlocker[] {
  return [
    ...input.bugs.map((bug): DashboardReleaseBlocker => ({
      type: "Bug",
      id: bug.id,
      title: bug.title,
      severityOrPriority: bug.severity,
      ageDays: bug.ageDays,
      recommendedAction: bug.severity === "Critical" ? "Resolve or formally waive before release." : "Triage, fix, and verify before the release decision.",
      url: bug.url,
    })),
    ...input.blockers.map((blocker): DashboardReleaseBlocker => ({
      type: "Blocked Test",
      id: blocker.id,
      title: blocker.title,
      severityOrPriority: blocker.reason,
      ageDays: blocker.ageDays,
      recommendedAction: blocker.recommendedAction,
      url: blocker.url,
    })),
    ...input.requirements.map((requirement): DashboardReleaseBlocker => ({
      type: "Uncovered Requirement",
      id: requirement.id,
      title: requirement.title,
      severityOrPriority: requirement.priority ? `Priority ${requirement.priority}` : "High risk",
      ageDays: null,
      recommendedAction: "Link or create adequate test cases and execute them.",
      url: requirement.url,
    })),
  ].slice(0, DASHBOARD_LIMITS.tableRows);
}

function latestResultsByCase(results: AzureTestResult[]) {
  const map = new Map<string, AzureTestResult>();
  results.forEach((result) => {
    if (!result.testCaseId) return;
    const existing = map.get(result.testCaseId);
    if (!existing || dateTime(result.completedDate) > dateTime(existing.completedDate)) map.set(result.testCaseId, result);
  });
  return map;
}

function buildSectionAvailability(input: {
  selectedPlanId: string | null;
  suites: SuiteWithPath[];
  suiteResult: SourceResult<TestSuite[]>;
  pointsResult: SourceResult<PointWithSuite[]>;
  bugsResult: SourceResult<Requirement[]>;
  executionTotal: number;
}): DashboardAnalytics["metadata"]["sections"] {
  return {
    filters: availability(
      input.suiteResult.ok,
      input.suiteResult.ok ? undefined : input.suiteResult.error,
    ),
    testExecution: !input.selectedPlanId
      ? unavailable("No Azure Test Plan is available for the selected project.")
      : !input.suites.length
        ? unavailable("The selected Test Plan has no suites.")
        : !input.pointsResult.ok
          ? unavailable(input.pointsResult.error)
          : input.executionTotal
            ? available()
            : unavailable("No test points were returned for the selected Test Plan and suites."),
    bugs: input.bugsResult.ok ? available() : unavailable(input.bugsResult.error),
  };
}

function buildWarnings(input: {
  metadata: Awaited<ReturnType<typeof loadBaseMetadata>>;
  sections: DashboardAnalytics["metadata"]["sections"];
  dateRangePreset: DashboardDatePreset;
  currentSprintResolved: boolean;
  workItemsTruncated: boolean;
  runsTruncated: boolean;
  suitesTruncated: boolean;
  totalSuites: number;
}) {
  const warnings = [
    ...Object.values(input.metadata).filter((result): result is { ok: false; error: string } => !result.ok).map((result) => result.error),
    ...Object.values(input.sections).filter((section) => section.status === "partial" && section.message).map((section) => section.message as string),
  ];
  if (input.dateRangePreset === "current_sprint" && !input.currentSprintResolved) {
    warnings.push("Current sprint dates were unavailable, so the dashboard used the last 30 days.");
  }
  if (input.workItemsTruncated) warnings.push(`Work-item metrics are limited to ${DASHBOARD_LIMITS.workItems} items per type.`);
  if (input.runsTruncated) warnings.push(`Execution history is limited to the latest ${DASHBOARD_LIMITS.testRuns} runs.`);
  if (input.suitesTruncated) {
    warnings.push(`Execution, coverage, and blocker metrics reflect only the first ${DASHBOARD_LIMITS.suites} of ${input.totalSuites} test suites; apply a Test Suite filter for full coverage.`);
  }
  return unique(warnings);
}

function buildFilterMetadata(
  metadata: Awaited<ReturnType<typeof loadBaseMetadata>>,
  suites: SuiteWithPath[],
): DashboardFilterMetadata {
  const plans = metadata.plans.ok ? metadata.plans.data : [];
  const areas = metadata.areas.ok ? metadata.areas.data : [];
  const iterations = metadata.iterations.ok ? metadata.iterations.data : [];
  const users = metadata.users.ok ? metadata.users.data : [];
  const workItemTypes = metadata.workItemTypes.ok ? metadata.workItemTypes.data.filter(isRequirementType) : DEFAULT_REQUIREMENT_TYPES;
  return {
    testPlans: plans.map((item) => ({ value: item.id, label: item.name, description: `Test Plan ${item.id}` })),
    testSuites: suites.map((item) => ({ value: item.id, label: item.path, description: `Suite ${item.id}` })),
    areas: areas.map((item) => ({ value: item.path, label: item.path })),
    iterations: iterations.map((item) => ({
      value: item.path,
      label: item.path,
      startDate: item.startDate,
      finishDate: item.finishDate,
    })),
    workItemTypes: workItemTypes.map((item) => ({ value: item, label: item })),
    assignees: users.map((item) => ({ value: item.uniqueName ?? item.displayName, label: item.displayName, description: item.uniqueName })),
  };
}

function resolveDateRange(
  filters: DashboardAnalyticsInput["filters"],
  iterations: AzureIteration[],
): DashboardFilters["dateRange"] {
  const preset = filters?.datePreset ?? "30d";
  const today = new Date();
  const to = dayString(today);
  if (preset === "custom" && filters?.from && filters.to && filters.from <= filters.to) {
    return { preset, from: filters.from, to: filters.to };
  }
  if (preset === "current_sprint") {
    const iteration = findCurrentIteration(iterations);
    if (iteration?.startDate && iteration.finishDate) {
      return { preset, from: datePart(iteration.startDate) as string, to: datePart(iteration.finishDate) as string };
    }
  }
  const days = preset === "7d" ? 7 : preset === "14d" ? 14 : 30;
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  return { preset, from: dayString(fromDate), to };
}

function findCurrentIteration(iterations: AzureIteration[]) {
  const now = Date.now();
  return iterations.find((iteration) => {
    const start = dateTime(iteration.startDate);
    const finish = dateTime(iteration.finishDate);
    return start > 0 && finish > 0 && start <= now && finish >= now;
  });
}

function flattenSuites(suites: TestSuite[], parentPath = ""): SuiteWithPath[] {
  return suites.flatMap((suite) => {
    const path = parentPath ? `${parentPath} / ${suite.name}` : suite.name;
    return [{ ...suite, path }, ...flattenSuites(suite.children ?? [], path)];
  });
}

function metric(
  availableValue: boolean,
  numerator: number,
  denominator: number,
  percentage: number | null,
  supportingText: string,
) {
  return {
    value: availableValue ? percentage : null,
    numerator: availableValue ? numerator : null,
    denominator: availableValue ? denominator : null,
    percentage: availableValue ? percentage : null,
    supportingText: availableValue ? supportingText : "No data available",
    available: availableValue,
  };
}

function countMetric(availableValue: boolean, value: number, supportingText: string) {
  return {
    value: availableValue ? value : null,
    supportingText: availableValue ? supportingText : "No data available",
    available: availableValue,
  };
}

function countOutcomes(items: DashboardExecutionItem[]) {
  return {
    passed: items.filter((item) => item.outcome === "passed").length,
    failed: items.filter((item) => item.outcome === "failed").length,
    blocked: items.filter((item) => item.outcome === "blocked").length,
    notRun: items.filter((item) => item.outcome === "not_run").length,
    skipped: items.filter((item) => item.outcome === "skipped").length,
  };
}

function outcomeDistribution(counts: ReturnType<typeof countOutcomes>): DashboardDistributionDatum[] {
  return [
    { key: "passed", name: "Passed", value: counts.passed },
    { key: "failed", name: "Failed", value: counts.failed },
    { key: "blocked", name: "Blocked", value: counts.blocked },
    { key: "not_run", name: "Not Run", value: counts.notRun },
    { key: "skipped", name: "Skipped / N/A", value: counts.skipped },
  ];
}

function buildWorkItemUrl(
  adapter: IntegrationProvider,
  scope: ProjectScope,
  id: string,
) {
  try {
    return adapter.buildWorkItemWebUrl({ projectId: scope.azureProjectId, projectName: scope.azureProjectName, workItemId: id });
  } catch {
    return null;
  }
}

function isRequirementType(value: string) {
  return DEFAULT_REQUIREMENT_TYPES.some((type) => type.toLowerCase() === value.toLowerCase()) || value.toLowerCase() === "feature";
}

function isDateInRange(value: string | undefined, from: string, to: string) {
  const date = datePart(value);
  return Boolean(date && date >= from && date <= to);
}

function datePart(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : toLocalDayString(date);
}

function dateTime(value?: string | null) {
  if (!value) return 0;
  const result = new Date(value).getTime();
  return Number.isNaN(result) ? 0 : result;
}

function dayString(value: Date) {
  return toLocalDayString(value);
}

function severityRank(value: string) {
  return { Critical: 0, High: 1, Medium: 2, Low: 3, Unknown: 4 }[value] ?? 5;
}

function available(): DashboardSectionAvailability {
  return { status: "available" };
}

function partial(message: string): DashboardSectionAvailability {
  return { status: "partial", message };
}

function unavailable(message: string): DashboardSectionAvailability {
  return { status: "unavailable", message };
}

function availability(ok: boolean, message?: string): DashboardSectionAvailability {
  return ok ? available() : partial(message ?? "Some filter metadata could not be loaded.");
}

async function capture<T>(operation: () => Promise<T>): Promise<SourceResult<T>> {
  try {
    return { ok: true, data: await operation() };
  } catch (error) {
    return { ok: false, error: errorMessage(error, "Azure DevOps data could not be loaded.") };
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function buildCacheKey(scope: ProjectScope, filters: DashboardAnalyticsInput["filters"]) {
  const f = filters ?? {};
  const canonical = {
    datePreset: f.datePreset ?? null,
    from: f.from ?? null,
    to: f.to ?? null,
    testPlanId: f.testPlanId ?? null,
    testSuiteIds: [...(f.testSuiteIds ?? [])].sort(),
    areaPath: f.areaPath ?? null,
    iterationPath: f.iterationPath ?? null,
    workItemTypes: [...(f.workItemTypes ?? [])].sort(),
    assignee: f.assignee ?? null,
  };
  // Keyed on the project id (a globally-unique ADO GUID) + canonical filters. The org
  // URL is fixed by server runtime settings, so it adds nothing but a client-forgeable
  // partition dimension — deliberately excluded.
  return `${scope.azureProjectId}|${JSON.stringify(canonical)}`;
}

function pruneAndSet<V>(
  cache: Map<string, { expiresAt: number; value: V }>,
  key: string,
  entry: { expiresAt: number; value: V },
  maxEntries: number,
) {
  const now = Date.now();
  for (const [existingKey, existingValue] of cache) {
    if (existingValue.expiresAt <= now) cache.delete(existingKey);
  }
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// Exposed for unit tests only — these are otherwise module-private pure helpers
// (no I/O). Tests import this barrel rather than the heavyweight getDashboardAnalytics.
export const __testables = {
  latestResultsByCase,
  resolveDateRange,
  datePart,
};
