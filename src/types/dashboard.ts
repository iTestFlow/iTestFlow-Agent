export type DashboardReadinessStatus = "ready" | "at_risk" | "not_ready" | "unknown";
export type DashboardSectionStatus = "available" | "partial" | "unavailable";
export type DashboardDatePreset = "7d" | "14d" | "30d" | "current_sprint" | "custom";
export type DashboardTestOutcome = "passed" | "failed" | "blocked" | "not_run" | "skipped";
export type DashboardRiskStatus = "critical" | "high" | "medium" | "low" | "unknown";
export type DashboardCoverageStatus = "covered" | "partially_covered" | "not_covered" | "unknown";
export type DashboardExecutionHealth = "passing" | "failing" | "blocked" | "not_run" | "mixed" | "unknown";
export type DashboardTab = "testing" | "bugs" | "coverage" | "blockers" | "trends";
export type DashboardActionSeverity = "critical" | "high" | "medium" | "info";

export type DashboardDateRange = {
  preset: DashboardDatePreset;
  from: string;
  to: string;
};

export type DashboardFilters = {
  dateRange: DashboardDateRange;
  testPlanId: string | null;
  testSuiteIds: string[];
  areaPath: string | null;
  iterationPath: string | null;
  workItemTypes: string[];
  assignee: string | null;
};

export type DashboardFilterOption = {
  value: string;
  label: string;
  description?: string;
};

export type DashboardFilterMetadata = {
  testPlans: DashboardFilterOption[];
  testSuites: DashboardFilterOption[];
  areas: DashboardFilterOption[];
  iterations: Array<DashboardFilterOption & { startDate?: string; finishDate?: string }>;
  workItemTypes: DashboardFilterOption[];
  assignees: DashboardFilterOption[];
};

export type DashboardMetric = {
  value: number | null;
  numerator?: number | null;
  denominator?: number | null;
  percentage?: number | null;
  label?: string;
  supportingText: string;
  available: boolean;
};

export type DashboardKpis = {
  releaseReadiness: {
    status: DashboardReadinessStatus;
    score: number | null;
    reasons: string[];
  };
  testExecutionProgress: DashboardMetric;
  passRate: DashboardMetric;
  openBugs: DashboardMetric;
  openCriticalHighBugs: DashboardMetric;
  blockedTests: DashboardMetric;
  requirementsCoverage: DashboardMetric;
  retestPending: DashboardMetric;
};

export type DashboardDistributionDatum = {
  name: string;
  value: number;
  key?: string;
};

export type DashboardExecutionModuleRow = {
  module: string;
  total: number;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  skipped: number;
  passRate: number | null;
  status: DashboardRiskStatus;
};

export type DashboardActionItem = {
  id: string;
  severity: DashboardActionSeverity;
  message: string;
  actionLabel: string;
  target: DashboardTab | "readiness";
};

export type DashboardTrendPoint = {
  date: string;
  executed?: number;
  passed?: number;
  failed?: number;
  blocked?: number;
  passRate?: number | null;
  opened?: number;
  closed?: number;
  reopened?: number;
  criticalHighOpened?: number;
};

export type DashboardBugRow = {
  id: string;
  title: string;
  severity: string;
  priority: number | null;
  status: string;
  assignee: string | null;
  ageDays: number | null;
  linkedRequirementId: string | null;
  linkedRequirementTitle: string | null;
  url: string | null;
};

export type DashboardRequirementRow = {
  id: string;
  title: string;
  priority: number | null;
  module: string;
  acceptanceCriteriaPresent: boolean;
  testCasesCount: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  coverageStatus: DashboardCoverageStatus;
  executionHealth: DashboardExecutionHealth;
  riskStatus: DashboardRiskStatus;
  url: string | null;
};

export type DashboardCoverageModuleRow = {
  module: string;
  covered: number;
  total: number;
  percentage: number | null;
};

export type DashboardReleaseBlocker = {
  type: "Bug" | "Blocked Test" | "Uncovered Requirement";
  id: string;
  title: string;
  severityOrPriority: string;
  owner: string | null;
  ageDays: number | null;
  recommendedAction: string;
  url: string | null;
};

export type DashboardBlockerRow = {
  id: string;
  title: string;
  reason: string;
  owner: string | null;
  ageDays: number | null;
  impactedArea: string | null;
  status: string;
  recommendedAction: string;
  url: string | null;
};

export type DashboardSectionAvailability = {
  status: DashboardSectionStatus;
  message?: string;
  truncated?: boolean;
  sourceTimestamp?: string;
};

export type DashboardAnalytics = {
  generatedAt: string;
  filters: DashboardFilters;
  filterMetadata: DashboardFilterMetadata;
  kpis: DashboardKpis;
  actions: DashboardActionItem[];
  testingProgress: {
    statusDistribution: DashboardDistributionDatum[];
    byModule: DashboardExecutionModuleRow[];
    trend: DashboardTrendPoint[];
    table: DashboardExecutionModuleRow[];
  };
  bugStatus: {
    bySeverity: DashboardDistributionDatum[];
    byPriority: DashboardDistributionDatum[];
    byStatus: DashboardDistributionDatum[];
    closedCount: number;
    openClosedTrend: DashboardTrendPoint[];
    agingBugs: DashboardBugRow[];
    reopenedBugs: DashboardBugRow[];
  };
  coverage: {
    coveredVsUncovered: DashboardDistributionDatum[];
    byModule: DashboardCoverageModuleRow[];
    byPriority: DashboardCoverageModuleRow[];
    coverageGaps: DashboardRequirementRow[];
    executionRiskRequirements: DashboardRequirementRow[];
    matrix: DashboardRequirementRow[];
  };
  releaseReadiness: {
    status: DashboardReadinessStatus;
    score: number | null;
    summary: string;
    reasons: string[];
    blockers: DashboardReleaseBlocker[];
  };
  blockers: {
    byReason: DashboardDistributionDatum[];
    aging: DashboardBlockerRow[];
  };
  trends: {
    execution: DashboardTrendPoint[];
    passRate: DashboardTrendPoint[];
    bugs: DashboardTrendPoint[];
  };
  metadata: {
    dataCompleteness: {
      hasTestExecutionData: boolean;
      hasBugData: boolean;
      hasCoverageData: boolean;
      hasTrendData: boolean;
    };
    sections: Record<
      "filters" | "testExecution" | "bugs" | "coverage" | "trends",
      DashboardSectionAvailability
    >;
    warnings: string[];
  };
};

export type DashboardActivityDatum = {
  day: string;
  Requirement: number;
  "Test cases": number;
  Coverage: number;
  Publish: number;
};

export type DashboardChartDatum = {
  name: string;
  value: number;
};

export type DashboardRecentActivity = {
  id: string;
  action: string;
  status: string;
  message: string;
  projectName: string | null;
  createdAt: string;
  audit: DashboardAuditLog;
};

export type DashboardAuditLog = {
  id: string;
  projectId: string | null;
  azureProjectId: string | null;
  azureProjectName: string | null;
  azureOrganizationUrl: string | null;
  entityType: string | null;
  entityId: string | null;
  action: string;
  status: string;
  actor: string | null;
  message: string;
  detailsJson: unknown;
  createdAt: string;
  updatedAt: string;
};
