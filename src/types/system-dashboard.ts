import type { WorkflowType } from "@/modules/analytics/analytics-config";

export type WorkflowRunStatus =
  | "started"
  | "generated"
  | "reviewed"
  | "published"
  | "completed"
  | "failed"
  | "cancelled";

export type SystemDashboardDatePreset = "7d" | "14d" | "30d" | "custom";

export type SystemDashboardFilters = {
  dateRange: {
    preset: SystemDashboardDatePreset;
    from: string;
    to: string;
  };
  workflowTypes: WorkflowType[];
  userId: string | null;
};

export type SystemDashboardMetric = {
  value: number | null;
  available: boolean;
  supportingText: string;
};

export type WorkflowSavingsRow = {
  workflowType: WorkflowType;
  workflow: string;
  runs: number;
  manualBaselineMinutes: number;
  actualAverageMinutes: number | null;
  averageSavedMinutes: number;
  totalSavedMinutes: number;
  potentialSavedMinutes: number;
  acceptanceRate: number | null;
};

export type SystemDashboardAnalytics = {
  generatedAt: string;
  filters: SystemDashboardFilters;
  filterMetadata: {
    workflows: Array<{ value: WorkflowType; label: string }>;
    users: Array<{ value: string; label: string }>;
  };
  overview: {
    estimatedHoursSaved: SystemDashboardMetric;
    workflowsCompleted: SystemDashboardMetric;
    highRiskIssuesFound: SystemDashboardMetric;
    testCasesPublished: SystemDashboardMetric;
    acceptanceRate: SystemDashboardMetric;
    mostValuableWorkflow: string | null;
    manualActionsAvoided: number;
  };
  workflowSavings: {
    rows: WorkflowSavingsRow[];
    trend: Array<{ date: string; savedHours: number; potentialSavedHours: number }>;
  };
  requirementQuality: {
    requirementsAnalyzed: number;
    averageTestabilityScore: number | null;
    requirementsWithCriticalHighGaps: number;
    totalGapsFound: number;
    averageRisksPerRequirement: number | null;
    mostCommonIssueCategory: string | null;
    issueCategories: Array<{ name: string; value: number }>;
  };
  testDesignCoverage: {
    testCasesGenerated: number;
    testCasesPublished: number;
    averageTestCasesPerStory: number | null;
    accepted: number;
    edited: number;
    rejected: number;
    estimatedHoursSaved: number;
    storiesReviewedForCoverage: number;
    averageCoverageScore: number | null;
    missingCoverageAreas: number;
    weakDuplicateCases: number;
    coverageCategories: Array<{ name: string; value: number }>;
  };
  knowledgeHub: {
    indexedWorkItems: number;
    knowledgeItems: number;
    lastRefresh: string | null;
    failedIndexingRuns: number;
    aiRunsUsingContext: number;
    contextUsageRate: number | null;
    mostReferencedContextItems: Array<{ name: string; value: number }>;
    staleKnowledgeWarnings: number;
  };
  adoAutomation: {
    commentsPublished: number;
    testCasesCreated: number;
    workItemsLinked: number;
    suiteMigrationsCompleted: number;
    bulkTasksCreated: number;
    manualActionsAvoided: number;
    publishSuccessRate: number | null;
    failedOperations: number;
  };
  adoptionFeedback: {
    activeUsers: number;
    runsPerUser: number | null;
    mostUsedFeature: string | null;
    averageFeedbackRating: number | null;
    usefulOutputRate: number | null;
    rejectionRate: number | null;
    topWorkflowByAdoption: string | null;
    feedbackCount: number;
  };
  warnings: string[];
};
