export type DashboardKpis = {
  indexedWorkItems: number;
  contextChunks: number;
  requirementRuns: number;
  generatedCases: number;
  coverageReviews: number;
  publishAttempts: number;
  llmSuccessRate: number;
  averageLlmDurationMs: number;
};

export type DashboardChartDatum = {
  name: string;
  value: number;
};

export type DashboardActivityDatum = {
  day: string;
  Requirement: number;
  "Test cases": number;
  Coverage: number;
  Publish: number;
};

export type DashboardRecentActivity = {
  id: string;
  action: string;
  status: string;
  message: string;
  projectName: string | null;
  createdAt: string;
};

export type DashboardAnalytics = {
  generatedAt: string;
  kpis: DashboardKpis;
  charts: {
    activityByDay: DashboardActivityDatum[];
    workItemStates: DashboardChartDatum[];
    llmProviderStatus: DashboardChartDatum[];
    auditStatus: DashboardChartDatum[];
    publishOutcomes: DashboardChartDatum[];
  };
  recentActivity: DashboardRecentActivity[];
};
