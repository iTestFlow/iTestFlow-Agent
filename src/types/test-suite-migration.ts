import type { AzureIdentityRef, TestConfigurationReference, TestSuiteType } from "@/modules/integrations/azure-devops/azure-devops-types";
import type { ActiveProjectScope } from "@/shared/lib/active-project";

export type SuiteMigrationOperationMode = "copy" | "move";
export type OutcomeMigrationMode = "none" | "latestOutcome" | "latestOutcomeAndTester";
export type SuiteConflictStrategy = "renameWithMigratedSuffix";
export type MigrationStatus = "draftPreview" | "readyToMigrate" | "migrating" | "completed" | "partiallyCompleted" | "failed" | "cancelled";

export type SuiteTreeNode = {
  id: string;
  name: string;
  planId: string;
  parentSuiteId?: string;
  parentSuiteName?: string;
  suiteType?: TestSuiteType | string;
  requirementId?: string;
  queryString?: string;
  inheritDefaultConfigurations?: boolean;
  defaultConfigurations?: TestConfigurationReference[];
  defaultTesters?: AzureIdentityRef[];
  path: string;
  children: SuiteTreeNode[];
};

export type TestSuiteMigrationRequest = {
  scope: ActiveProjectScope;
  sourceProjectId: string;
  sourceTestPlanId: string;
  selectedSuiteIds: string[];
  targetProjectId: string;
  targetTestPlanId: string;
  targetParentSuiteId: string;
  operationMode: SuiteMigrationOperationMode;
  outcomeMode: OutcomeMigrationMode;
  overwriteTargetOutcomes: boolean;
  conflictStrategy: SuiteConflictStrategy;
};

export type NormalizedSelectedSuiteRoot = {
  id: string;
  name: string;
  path: string;
  skippedDescendantSelections: string[];
};

export type RecursiveSuiteMigrationNode = {
  sourceSuiteId: string;
  sourceSuitePath: string;
  sourceSuiteName: string;
  sourceParentSuiteId?: string;
  targetSuiteName: string;
  targetSuitePath: string;
  targetParentSourceSuiteId?: string;
  targetParentSuiteId?: string;
  suiteType?: TestSuiteType | string;
  requirementId?: string;
  queryString?: string;
  inheritDefaultConfigurations?: boolean;
  defaultConfigurations?: TestConfigurationReference[];
  defaultTesters?: AzureIdentityRef[];
};

export type SourceTestPointSnapshot = {
  id: string;
  sourceSuiteId: string;
  sourceSuitePath: string;
  testCaseId?: string;
  testCaseTitle?: string;
  configurationId?: string;
  configurationName?: string;
  latestOutcome?: string;
  latestOutcomeCategory: string;
  lastRunDate?: string;
  lastUpdatedDate?: string;
  tester?: AzureIdentityRef;
};

export type TargetSuiteMapping = {
  sourceSuiteId: string;
  sourceSuitePath: string;
  targetSuiteId: string;
  targetSuitePath: string;
  targetSuiteName: string;
};

export type TargetTestPointMatch = {
  sourcePointId: string;
  targetPointId?: string;
  targetSuiteId?: string;
  testCaseId?: string;
  configurationId?: string;
  status: "mapped" | "unmapped" | "skipped" | "failed";
  reason?: string;
};

export type MigrationSeverity = "info" | "warning" | "error";

export type MigrationWarning = {
  code: string;
  message: string;
  severity: MigrationSeverity;
  suiteId?: string;
  testCaseId?: string;
};

export type MigrationError = {
  code: string;
  message: string;
  suiteId?: string;
  testCaseId?: string;
  pointId?: string;
};

export type MigrationPreviewRow = {
  sourceRootSuite: string;
  sourceSuitePath: string;
  sourceSuiteId: string;
  sourceTestCaseId?: string;
  sourceTestCaseTitle?: string;
  sourceConfiguration?: string;
  sourceLatestOutcome?: string;
  sourceLastRunDate?: string;
  targetSuitePath: string;
  targetTestCaseId?: string;
  targetConfiguration?: string;
  mappingStatus: "mapped" | "unmapped" | "willUpdate" | "willSkip" | "willOverwrite" | "warning" | "error";
  plannedAction: string;
  warningOrError?: string;
};

export type MigrationPreview = {
  status: MigrationStatus;
  sourceProjectId: string;
  sourceTestPlanId: string;
  targetProjectId: string;
  targetTestPlanId: string;
  targetParentSuiteId: string;
  selectedRootSuiteCount: number;
  totalSuiteCount: number;
  childSuitesIncludedCount: number;
  totalSourceTestCaseCount: number;
  totalSourceTestPointCount: number;
  expectedTargetSuiteCount: number;
  expectedTargetTestPointCount: number;
  mappableOutcomeCount: number;
  unmappedTestPointCount: number;
  targetPointsWithExistingOutcomes: number;
  skippedBecauseOverwriteDisabled: number;
  overwrittenIfEnabled: number;
  outcomeBreakdown: Record<string, number>;
  selectedRoots: NormalizedSelectedSuiteRoot[];
  plannedSuites: RecursiveSuiteMigrationNode[];
  warnings: MigrationWarning[];
  errors: MigrationError[];
  rows: MigrationPreviewRow[];
  generatedAt: string;
};

export type MigrationAction = {
  action: "createSuite" | "addTestCase" | "updateOutcome" | "skipOutcome" | "deleteSourceSuite" | "validate";
  status: "success" | "skipped" | "failed";
  message: string;
  sourceSuiteId?: string;
  targetSuiteId?: string;
  testCaseId?: string;
  sourcePointId?: string;
  targetPointId?: string;
};

export type MigrationReport = {
  status: MigrationStatus;
  operationTimestamp: string;
  sourceProjectId: string;
  sourceTestPlanId: string;
  targetProjectId: string;
  targetTestPlanId: string;
  targetParentSuiteId: string;
  suiteMappings: TargetSuiteMapping[];
  actions: MigrationAction[];
  warnings: MigrationWarning[];
  errors: MigrationError[];
  summary: {
    suitesCreated: number;
    testCasesAdded: number;
    outcomesUpdated: number;
    outcomesSkipped: number;
    outcomesFailed: number;
    sourceSuitesDeleted: number;
  };
};

export type MigrationResult = {
  preview: MigrationPreview;
  report: MigrationReport;
};
