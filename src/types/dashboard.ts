export type DashboardKpis = {
  indexedWorkItems: number;
  businessRules: number;
  requirementRuns: number;
  generatedCases: number;
  coverageReviews: number;
  llmSuccessRate: number;
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

export type DashboardAnalytics = {
  generatedAt: string;
  kpis: DashboardKpis;
  recentActivity: DashboardRecentActivity[];
  recentActivityHasMore: boolean;
};
