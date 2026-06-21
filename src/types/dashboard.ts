export type DashboardReadinessStatus = "ready" | "at_risk" | "not_ready" | "unknown";
export type DashboardSectionStatus = "available" | "partial" | "unavailable";
export type DashboardDatePreset = "7d" | "14d" | "30d" | "current_sprint" | "custom";
export type DashboardTestOutcome = "passed" | "failed" | "blocked" | "not_run" | "skipped";
export type DashboardRiskStatus = "critical" | "high" | "medium" | "low" | "unknown";
export type DashboardCoverageStatus = "covered" | "partially_covered" | "not_covered" | "unknown";
export type DashboardExecutionHealth = "passing" | "failing" | "blocked" | "not_run" | "mixed" | "unknown";
export type DashboardTab = "testing" | "bugs" | "blockers";

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
  testExecutionProgress: DashboardMetric;
  passRate: DashboardMetric;
  openBugs: DashboardMetric;
  openCriticalHighBugs: DashboardMetric;
  requirementsCoverage: DashboardMetric;
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

export type DashboardBugRow = {
  id: string;
  title: string;
  severity: string;
  priority: number | null;
  status: string;
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

export type DashboardReleaseBlocker = {
  type: "Bug" | "Blocked Test" | "Uncovered Requirement";
  id: string;
  title: string;
  severityOrPriority: string;
  ageDays: number | null;
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
  testingProgress: {
    statusDistribution: DashboardDistributionDatum[];
    table: DashboardExecutionModuleRow[];
  };
  bugStatus: {
    bySeverity: DashboardDistributionDatum[];
    agingBugs: DashboardBugRow[];
  };
  releaseReadiness: {
    status: DashboardReadinessStatus;
    score: number | null;
    summary: string;
    reasons: string[];
    blockers: DashboardReleaseBlocker[];
  };
  metadata: {
    sections: Record<
      "filters" | "testExecution" | "bugs",
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
