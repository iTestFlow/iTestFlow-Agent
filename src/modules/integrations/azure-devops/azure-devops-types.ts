export type {
  AddSuiteTestCaseInput,
  Area as AzureArea,
  AttachmentUpload as AzureAttachmentUpload,
  BugCustomField as AzureBugCustomField,
  BugWorkItemInput as AzureBugWorkItemInput,
  CreateTestSuiteInput,
  FinalApprovedTestCase,
  IdentityRef as AzureIdentityRef,
  Iteration as AzureIteration,
  ProjectUser as AzureProjectUser,
  ProjectWorkItemMetadata as AzureProjectWorkItemMetadata,
  ProviderAuthenticatedUser as AzureAuthenticatedUser,
  ProviderProject as AzureProject,
  Requirement,
  TestCase,
  TestCasePriority,
  TestConfigurationReference,
  TestPlan,
  TestPoint as AzureTestPoint,
  TestResult as AzureTestResult,
  TestRun as AzureTestRun,
  TestStep,
  TestSuite,
  TestSuiteType,
  UpdateTestPointInput,
  WorkItemFieldType as AzureWorkItemFieldType,
  WorkItemFieldValue as AzureWorkItemFieldValue,
  WorkItemRevision as AzureWorkItemRevision,
  WorkItemTypeField as AzureWorkItemTypeField,
} from "../core/integration-types";

export type AzureDevOpsSettings = {
  organizationUrl: string;
  personalAccessToken: string;
};

export type BulkTaskTemplate = {
  templateId: string;
  title: string;
  description?: string;
  assignedTo?: string;
  originalEstimate?: number;
  copyEstimateToRemainingWork?: boolean;
};

export type BulkTaskTarget = {
  storyId: string;
  taskOverrides?: BulkTaskTargetOverride[];
};

export type BulkTaskTargetOverride = {
  templateId: string;
  assignedTo?: string;
  originalEstimate?: number;
};

export type CreatedBulkTask = {
  templateId: string;
  storyId: string;
  taskId: string;
  title: string;
};

export type FailedBulkTask = {
  templateId: string;
  storyId: string;
  title: string;
  error: string;
};

export type BulkTaskResult = {
  templateId: string;
  storyId: string;
  title: string;
  status: "created" | "failed" | "skipped";
  taskId?: string;
  error?: string;
};
