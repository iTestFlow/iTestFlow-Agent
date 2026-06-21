import type { WorkflowType } from "@/modules/analytics/analytics-config";

export type WorkflowRunStatus =
  | "started"
  | "generated"
  | "reviewed"
  | "published"
  | "completed"
  | "failed"
  | "cancelled";

export type SystemDashboardDatePreset = "7d" | "14d" | "30d" | "overall" | "custom";

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
  totalSavedMinutes: number;
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
    testCasesPublished: SystemDashboardMetric;
    manualActionsAvoided: number;
  };
  workflowSavings: {
    rows: WorkflowSavingsRow[];
    trend: Array<{ date: string; savedHours: number }>;
  };
  adoption: {
    activeUsers: number;
    workflowRuns: number;
    mostUsedFeature: string | null;
  };
  warnings: string[];
};
