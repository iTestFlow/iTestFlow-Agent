import type {
  DashboardBlockerRow,
  DashboardActionItem,
  DashboardCoverageModuleRow,
  DashboardCoverageStatus,
  DashboardExecutionHealth,
  DashboardDistributionDatum,
  DashboardExecutionModuleRow,
  DashboardReadinessStatus,
  DashboardRequirementRow,
  DashboardRiskStatus,
  DashboardTestOutcome,
  DashboardTrendPoint,
} from "@/types/dashboard";
import { toLocalDayString } from "@/shared/lib/local-day";

export const DASHBOARD_LIMITS = {
  workItems: 1000,
  testRuns: 200,
  trendRuns: 60,
  testResults: 5000,
  revisions: 5000,
  tableRows: 100,
  suites: 100,
} as const;

export const READINESS_THRESHOLDS = {
  minimumExecutionCompletion: 90,
  minimumPassRate: 95,
  notReadyPassRate: 80,
  maximumCriticalBugs: 0,
  maximumHighBugsForReady: 0,
  notReadyHighBugs: 3,
  maximumBlockedTestsForReady: 0,
  notReadyBlockedTests: 5,
  maximumHighRiskUncoveredRequirements: 0,
} as const;

const closedStateTokens = ["closed", "done", "completed", "removed", "rejected"];
const resolvedStateTokens = ["resolved", "fixed", "ready for retest", "ready to test"];

// Match a state name that *begins* with a token word, so decorated states like
// "Closed - Duplicate" / "Done (Verified)" classify correctly, while a negated state
// like "Not Done" / "Not Fixed" (which only contains the token) does NOT. The trailing
// \b stops a token from matching a longer word ("done" must not match "doner").
const toStatePattern = (token: string) => new RegExp(`^${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
const closedStatePatterns = closedStateTokens.map(toStatePattern);
const resolvedStatePatterns = resolvedStateTokens.map(toStatePattern);

function matchesState(value: string | null | undefined, patterns: RegExp[]) {
  const normalized = (value ?? "").trim().toLowerCase();
  return patterns.some((pattern) => pattern.test(normalized));
}

export function normalizeSeverity(value?: string | null) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "Unknown";
  if (normalized.includes("critical") || /^1\b/.test(normalized)) return "Critical";
  if (normalized.includes("high") || /^2\b/.test(normalized)) return "High";
  if (normalized.includes("medium") || /^3\b/.test(normalized)) return "Medium";
  if (normalized.includes("low") || /^4\b/.test(normalized)) return "Low";
  return titleCase(value ?? "Unknown");
}

export function normalizePriority(value?: number | null) {
  return value && value >= 1 && value <= 4 ? value : null;
}

export function normalizeTestOutcome(value?: string | null): DashboardTestOutcome {
  const normalized = (value ?? "").replace(/[\s_-]+/g, "").toLowerCase();
  if (["passed", "pass", "succeeded"].includes(normalized)) return "passed";
  if (["failed", "fail", "error", "aborted"].includes(normalized)) return "failed";
  if (["blocked", "paused"].includes(normalized)) return "blocked";
  if (["notapplicable", "skipped", "notimpacted"].includes(normalized)) return "skipped";
  return "not_run";
}

export function isOpenBugState(value?: string | null) {
  return !matchesState(value, closedStatePatterns);
}

export function isResolvedBugState(value?: string | null) {
  return matchesState(value, resolvedStatePatterns);
}

export function calculatePercentage(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

export function calculateAgingDays(value?: string | null, now = new Date()) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 86_400_000));
}

export function groupDistribution(values: string[], order: string[] = []): DashboardDistributionDatum[] {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => {
      const aIndex = order.indexOf(a.name);
      const bIndex = order.indexOf(b.name);
      if (aIndex !== -1 || bIndex !== -1) {
        return (aIndex === -1 ? order.length : aIndex) - (bIndex === -1 ? order.length : bIndex);
      }
      return b.value - a.value || a.name.localeCompare(b.name);
    });
}

export type DashboardExecutionItem = {
  id: string;
  testCaseId?: string | null;
  title: string;
  module: string;
  outcome: DashboardTestOutcome;
  owner?: string | null;
  lastRunDate?: string | null;
  reasonText?: string | null;
  url?: string | null;
};

export function buildExecutionRows(items: DashboardExecutionItem[]): DashboardExecutionModuleRow[] {
  const groups = new Map<string, DashboardExecutionItem[]>();
  items.forEach((item) => {
    const moduleName = item.module || "Unassigned";
    groups.set(moduleName, [...(groups.get(moduleName) ?? []), item]);
  });

  return [...groups.entries()]
    .map(([moduleName, group]) => {
      const passed = countOutcome(group, "passed");
      const failed = countOutcome(group, "failed");
      const blocked = countOutcome(group, "blocked");
      const notRun = countOutcome(group, "not_run");
      const skipped = countOutcome(group, "skipped");
      const executed = passed + failed + blocked + skipped;
      const passRate = calculatePercentage(passed, passed + failed + blocked);
      return {
        module: moduleName,
        total: group.length,
        executed,
        passed,
        failed,
        blocked,
        notRun,
        skipped,
        passRate,
        status: executionRisk({ passed, failed, blocked, notRun, passRate }),
      };
    })
    .sort((a, b) => riskRank(a.status) - riskRank(b.status) || b.total - a.total || a.module.localeCompare(b.module));
}

function countOutcome(items: DashboardExecutionItem[], outcome: DashboardTestOutcome) {
  return items.filter((item) => item.outcome === outcome).length;
}

function executionRisk(input: { passed: number; failed: number; blocked: number; notRun: number; passRate: number | null }): DashboardRiskStatus {
  const failedBlocked = input.failed + input.blocked;
  const population = Math.max(1, input.passed + input.failed + input.blocked + input.notRun);
  if (
    (input.passRate !== null && input.passRate < 60) ||
    input.blocked >= 5 ||
    (input.blocked >= 2 && input.blocked / population >= 0.25)
  ) return "critical";
  if (
    (input.passRate !== null && input.passRate < 80) ||
    failedBlocked >= 3 ||
    (failedBlocked >= 2 && failedBlocked / population >= 0.15)
  ) return "high";
  if (input.failed > 0 || input.blocked > 0 || input.notRun > 0 || (input.passRate !== null && input.passRate < 95)) return "medium";
  return "low";
}

export type DashboardRequirementInput = {
  id: string;
  title: string;
  priority?: number | null;
  module?: string | null;
  acceptanceCriteria?: string | null;
  linkedTestCaseIds: string[];
  openCriticalHighBugCount?: number;
  url?: string | null;
};

export function buildRequirementRows(
  requirements: DashboardRequirementInput[],
  outcomesByTestCaseId: Map<string, DashboardTestOutcome[]>,
): DashboardRequirementRow[] {
  return requirements.map((requirement) => {
    const outcomes = requirement.linkedTestCaseIds.flatMap((id) => outcomesByTestCaseId.get(id) ?? []);
    const passed = outcomes.filter((outcome) => outcome === "passed").length;
    const failed = outcomes.filter((outcome) => outcome === "failed").length;
    const blocked = outcomes.filter((outcome) => outcome === "blocked").length;
    const notRun = outcomes.filter((outcome) => outcome === "not_run").length;
    const coverageStatus = coverageStatusFor(requirement.linkedTestCaseIds.length);
    const executionHealth = executionHealthFor(outcomes);
    return {
      id: requirement.id,
      title: requirement.title,
      priority: normalizePriority(requirement.priority),
      module: requirement.module || "Unassigned",
      acceptanceCriteriaPresent: Boolean(requirement.acceptanceCriteria?.trim()),
      testCasesCount: requirement.linkedTestCaseIds.length,
      passed,
      failed,
      blocked,
      notRun,
      coverageStatus,
      executionHealth,
      riskStatus: requirementRisk({
        priority: requirement.priority,
        coverageStatus,
        executionHealth,
        failed,
        blocked,
        openCriticalHighBugCount: requirement.openCriticalHighBugCount ?? 0,
      }),
      url: requirement.url ?? null,
    };
  });
}

// Coverage is intentionally binary: a requirement is "covered" when it has at least one
// linked test case, independent of whether those tests pass. partially_covered/unknown are
// reserved on the type for the chip rendering but are never produced here.
function coverageStatusFor(linkCount: number): DashboardCoverageStatus {
  if (!linkCount) return "not_covered";
  return "covered";
}

export function isCovered(status: DashboardCoverageStatus) {
  return status === "covered" || status === "partially_covered";
}

function executionHealthFor(outcomes: DashboardTestOutcome[]): DashboardExecutionHealth {
  if (!outcomes.length) return "unknown";
  const meaningful = outcomes.filter((outcome) => outcome !== "skipped");
  if (!meaningful.length) return "unknown";
  if (meaningful.every((outcome) => outcome === "passed")) return "passing";
  if (meaningful.every((outcome) => outcome === "failed")) return "failing";
  if (meaningful.every((outcome) => outcome === "blocked")) return "blocked";
  if (meaningful.every((outcome) => outcome === "not_run")) return "not_run";
  return "mixed";
}

function requirementRisk(input: {
  priority?: number | null;
  coverageStatus: DashboardCoverageStatus;
  executionHealth: DashboardExecutionHealth;
  failed: number;
  blocked: number;
  openCriticalHighBugCount: number;
}): DashboardRiskStatus {
  if (
    input.priority === 1 &&
    (input.coverageStatus !== "covered" || input.failed > 0 || input.blocked > 0 || input.openCriticalHighBugCount > 0)
  ) {
    return "critical";
  }
  if (input.coverageStatus === "not_covered" || input.failed > 0 || input.blocked > 0 || input.openCriticalHighBugCount > 0) {
    return "high";
  }
  if (input.coverageStatus === "partially_covered") return "medium";
  return "low";
}

export function buildCoverageByModule(rows: DashboardRequirementRow[]): DashboardCoverageModuleRow[] {
  const groups = new Map<string, DashboardRequirementRow[]>();
  rows.forEach((row) => groups.set(row.module, [...(groups.get(row.module) ?? []), row]));
  return [...groups.entries()]
    .map(([moduleName, group]) => {
      const covered = group.filter((row) => isCovered(row.coverageStatus)).length;
      return { module: moduleName, covered, total: group.length, percentage: calculatePercentage(covered, group.length) };
    })
    .sort((a, b) => (a.percentage ?? -1) - (b.percentage ?? -1) || b.total - a.total);
}

export function buildCoverageByPriority(rows: DashboardRequirementRow[]): DashboardCoverageModuleRow[] {
  const groups = new Map<string, DashboardRequirementRow[]>();
  rows.forEach((row) => {
    const priority = row.priority ? `Priority ${row.priority}` : "Unknown priority";
    groups.set(priority, [...(groups.get(priority) ?? []), row]);
  });
  return [...groups.entries()]
    .map(([priority, group]) => {
      const covered = group.filter((row) => isCovered(row.coverageStatus)).length;
      return { module: priority, covered, total: group.length, percentage: calculatePercentage(covered, group.length) };
    })
    .sort((a, b) => priorityRank(a.module) - priorityRank(b.module));
}

export function classifyBlockerReason(text?: string | null) {
  const value = (text ?? "").toLowerCase();
  const rules: Array<[string, string[]]> = [
    ["Environment", ["environment", "deployment", "server", "build unavailable"]],
    ["Test Data", ["test data", "seed data", "data setup"]],
    ["API / Integration", ["api", "integration", "endpoint", "service unavailable"]],
    ["Access / Permission", ["access", "permission", "unauthorized", "forbidden"]],
    ["Requirement Clarification", ["requirement", "clarification", "acceptance criteria"]],
    ["Open Bug", ["bug", "defect", "issue"]],
    ["Dependency", ["dependency", "dependent", "waiting for"]],
  ];
  return rules.find(([, tokens]) => tokens.some((token) => value.includes(token)))?.[0] ?? "Unknown";
}

export function buildBlockerDistribution(items: DashboardBlockerRow[]) {
  return groupDistribution(
    items.map((item) => item.reason),
    ["Environment", "Test Data", "API / Integration", "Access / Permission", "Requirement Clarification", "Open Bug", "Dependency", "Unknown"],
  );
}

export type ReadinessInput = {
  executionAvailable: boolean;
  bugsAvailable: boolean;
  coverageAvailable: boolean;
  executionPercentage: number | null;
  passRate: number | null;
  openCriticalBugs: number;
  openHighBugs: number;
  blockedTests: number;
  highRiskUncoveredRequirements: number;
  retestPending: number;
};

export function calculateReleaseReadiness(input: ReadinessInput) {
  const reasons: string[] = [];
  const notReadyReasons: string[] = [];
  const atRiskReasons: string[] = [];

  if (input.openCriticalBugs > READINESS_THRESHOLDS.maximumCriticalBugs) {
    notReadyReasons.push(pluralReason(input.openCriticalBugs, "critical bug is", "critical bugs are", "open"));
  }
  if (input.openHighBugs >= READINESS_THRESHOLDS.notReadyHighBugs) {
    notReadyReasons.push(pluralReason(input.openHighBugs, "high severity bug is", "high severity bugs are", "open"));
  } else if (input.openHighBugs > READINESS_THRESHOLDS.maximumHighBugsForReady) {
    atRiskReasons.push(pluralReason(input.openHighBugs, "high severity bug is", "high severity bugs are", "open"));
  }
  if (input.passRate !== null && input.passRate < READINESS_THRESHOLDS.notReadyPassRate) {
    notReadyReasons.push(`pass rate is ${formatPercent(input.passRate)}, below the ${READINESS_THRESHOLDS.notReadyPassRate}% critical threshold`);
  } else if (input.passRate !== null && input.passRate < READINESS_THRESHOLDS.minimumPassRate) {
    atRiskReasons.push(`pass rate is ${formatPercent(input.passRate)}, below the ${READINESS_THRESHOLDS.minimumPassRate}% target`);
  }
  if (input.blockedTests >= READINESS_THRESHOLDS.notReadyBlockedTests) {
    notReadyReasons.push(`${input.blockedTests} test cases are blocked`);
  } else if (input.blockedTests > READINESS_THRESHOLDS.maximumBlockedTestsForReady) {
    atRiskReasons.push(`${input.blockedTests} test ${input.blockedTests === 1 ? "case is" : "cases are"} blocked`);
  }
  if (input.executionPercentage !== null && input.executionPercentage < READINESS_THRESHOLDS.minimumExecutionCompletion) {
    atRiskReasons.push(`execution completion is ${formatPercent(input.executionPercentage)}, below the ${READINESS_THRESHOLDS.minimumExecutionCompletion}% target`);
  }
  if (input.highRiskUncoveredRequirements > READINESS_THRESHOLDS.maximumHighRiskUncoveredRequirements) {
    atRiskReasons.push(`${input.highRiskUncoveredRequirements} high-risk ${input.highRiskUncoveredRequirements === 1 ? "requirement has" : "requirements have"} no adequate test coverage`);
  }
  if (input.retestPending > 0) {
    atRiskReasons.push(`${input.retestPending} resolved ${input.retestPending === 1 ? "bug is" : "bugs are"} pending verification`);
  }

  let status: DashboardReadinessStatus;
  if (notReadyReasons.length) status = "not_ready";
  else if (atRiskReasons.length) status = "at_risk";
  else if (input.executionAvailable && input.bugsAvailable && input.coverageAvailable) status = "ready";
  else status = "unknown";

  reasons.push(...notReadyReasons, ...atRiskReasons);
  if (status === "unknown") reasons.push("insufficient execution, bug, or coverage data is available");

  return {
    status,
    score: status === "unknown" ? null : calculateReadinessScore(input),
    reasons,
    summary: buildReleaseRiskSummary(status, reasons),
  };
}

function calculateReadinessScore(input: ReadinessInput) {
  if (!input.executionAvailable && !input.bugsAvailable && !input.coverageAvailable) return null;
  const executionScore = input.executionAvailable ? Math.min(input.executionPercentage ?? 0, 100) * 0.25 : 0;
  const passScore = input.executionAvailable ? Math.min(input.passRate ?? 0, 100) * 0.25 : 0;
  const defectPenalty = Math.min(100, input.openCriticalBugs * 50 + input.openHighBugs * 15);
  const defectScore = input.bugsAvailable ? (100 - defectPenalty) * 0.2 : 0;
  const coverageScore = input.coverageAvailable
    ? Math.max(0, 100 - input.highRiskUncoveredRequirements * 20) * 0.2
    : 0;
  const blockerPenalty = Math.min(100, input.blockedTests * 10 + input.retestPending * 5);
  const blockerScore = (input.executionAvailable || input.bugsAvailable) ? (100 - blockerPenalty) * 0.1 : 0;
  const availableWeight =
    (input.executionAvailable ? 0.5 : 0) +
    (input.bugsAvailable ? 0.2 : 0) +
    (input.coverageAvailable ? 0.2 : 0) +
    (input.executionAvailable || input.bugsAvailable ? 0.1 : 0);
  return availableWeight ? Math.round((executionScore + passScore + defectScore + coverageScore + blockerScore) / availableWeight) : null;
}

export function buildReleaseRiskSummary(status: DashboardReadinessStatus, reasons: string[]) {
  const label = status === "not_ready" ? "Not Ready" : status === "at_risk" ? "At Risk" : status === "ready" ? "Ready" : "Unknown";
  if (status === "ready") return "Release is Ready because the configured execution, defect, coverage, and blocker gates are satisfied.";
  const selected = reasons.slice(0, 3);
  if (!selected.length) return `Release readiness is ${label}.`;
  return `Release is ${label} because ${joinReasons(selected)}.`;
}

export function buildDailyTrend(
  from: string,
  to: string,
  points: DashboardTrendPoint[],
): DashboardTrendPoint[] {
  const byDate = new Map(points.map((point) => [point.date, point]));
  const result: DashboardTrendPoint[] = [];
  // Iterate local calendar days (note: no trailing Z) so the axis aligns with the
  // local-day buckets that datePart produces for each event.
  const cursor = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cursor <= end) {
    const date = toLocalDayString(cursor);
    result.push({ date, ...(byDate.get(date) ?? {}) });
    cursor.setDate(cursor.getDate() + 1);
  }
  return result;
}

export function trimTrailingEmptyTrend(points: DashboardTrendPoint[]) {
  let lastDataIndex = -1;
  points.forEach((point, index) => {
    if (Object.entries(point).some(([key, value]) => key !== "date" && typeof value === "number")) {
      lastDataIndex = index;
    }
  });
  return lastDataIndex >= 0 ? points.slice(0, lastDataIndex + 1) : points;
}

export function buildDashboardActions(input: {
  blockedTests: number;
  openCriticalBugs: number;
  openHighBugs: number;
  highRiskCoverageGaps: number;
  retestPending: number;
  passRate: number | null;
  executionPercentage: number | null;
}): DashboardActionItem[] {
  const actions: DashboardActionItem[] = [];
  if (input.blockedTests > 0) {
    actions.push({
      id: "blocked-tests",
      severity: input.blockedTests >= READINESS_THRESHOLDS.notReadyBlockedTests ? "critical" : "high",
      message: `${input.blockedTests} blocked ${input.blockedTests === 1 ? "test requires" : "tests require"} investigation.`,
      actionLabel: "View blockers",
      target: "blockers",
    });
  }
  const severeBugs = input.openCriticalBugs + input.openHighBugs;
  if (severeBugs > 0) {
    actions.push({
      id: "severe-bugs",
      severity: input.openCriticalBugs > 0 || input.openHighBugs >= READINESS_THRESHOLDS.notReadyHighBugs ? "critical" : "high",
      message: `${severeBugs} critical or high-severity ${severeBugs === 1 ? "bug is" : "bugs are"} still unclosed.`,
      actionLabel: "View bugs",
      target: "bugs",
    });
  }
  if (input.highRiskCoverageGaps > 0) {
    actions.push({
      id: "coverage-gaps",
      severity: "high",
      message: `${input.highRiskCoverageGaps} high-risk ${input.highRiskCoverageGaps === 1 ? "requirement needs" : "requirements need"} coverage review.`,
      actionLabel: "View coverage risks",
      target: "coverage",
    });
  }
  if (input.retestPending > 0) {
    actions.push({
      id: "retest-pending",
      severity: "medium",
      message: `${input.retestPending} resolved ${input.retestPending === 1 ? "bug is" : "bugs are"} pending verification.`,
      actionLabel: "View retest pending",
      target: "bugs",
    });
  }
  if (input.passRate !== null && input.passRate < READINESS_THRESHOLDS.minimumPassRate) {
    actions.push({
      id: "pass-rate",
      severity: input.passRate < READINESS_THRESHOLDS.notReadyPassRate ? "high" : "medium",
      message: `Pass rate is ${formatPercent(input.passRate)}, below the ${READINESS_THRESHOLDS.minimumPassRate}% target.`,
      actionLabel: "View testing progress",
      target: "testing",
    });
  }
  if (input.executionPercentage !== null && input.executionPercentage < READINESS_THRESHOLDS.minimumExecutionCompletion) {
    actions.push({
      id: "execution-progress",
      severity: "medium",
      message: `Execution completion is ${formatPercent(input.executionPercentage)}, below the ${READINESS_THRESHOLDS.minimumExecutionCompletion}% target.`,
      actionLabel: "View testing progress",
      target: "testing",
    });
  }
  return actions
    .sort((a, b) => actionRank(a.severity) - actionRank(b.severity))
    .slice(0, 5);
}

export function riskRank(value: DashboardRiskStatus) {
  return { critical: 0, high: 1, medium: 2, unknown: 3, low: 4 }[value];
}

function actionRank(value: DashboardActionItem["severity"]) {
  return { critical: 0, high: 1, medium: 2, info: 3 }[value];
}

function priorityRank(value: string) {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : 99;
}

function titleCase(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatPercent(value: number) {
  return `${Math.round(value * 10) / 10}%`;
}

function pluralReason(count: number, singular: string, plural: string, suffix: string) {
  return `${count} ${count === 1 ? singular : plural} ${suffix}`;
}

function joinReasons(reasons: string[]) {
  if (reasons.length === 1) return reasons[0];
  if (reasons.length === 2) return `${reasons[0]} and ${reasons[1]}`;
  return `${reasons.slice(0, -1).join(", ")}, and ${reasons.at(-1)}`;
}
