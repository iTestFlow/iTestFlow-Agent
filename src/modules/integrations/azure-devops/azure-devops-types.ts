export type AzureProject = {
  id: string;
  name: string;
  url?: string;
  state?: string;
  visibility?: string;
};

export type AzureAuthenticatedUser = {
  id?: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
};

export type AzureIteration = {
  id: string;
  name: string;
  path: string;
  startDate?: string;
  finishDate?: string;
};

export type AzureArea = {
  id: string;
  name: string;
  path: string;
};

export type AzureProjectUser = {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
};

export type AzureWorkItemFieldValue = string | number | boolean;

export type AzureWorkItemFieldType =
  | "string"
  | "integer"
  | "dateTime"
  | "plainText"
  | "html"
  | "treePath"
  | "history"
  | "double"
  | "guid"
  | "boolean"
  | "identity"
  | "picklistInteger"
  | "picklistString"
  | "picklistDouble"
  | string;

export type AzureWorkItemTypeField = {
  name: string;
  referenceName: string;
  type?: AzureWorkItemFieldType;
  helpText?: string;
  required?: boolean;
  alwaysRequired?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  allowedValues?: AzureWorkItemFieldValue[];
};

export type Requirement = {
  id: string;
  azureProjectId: string;
  workItemType: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  state?: string;
  assignedTo?: string;
  priority?: number;
  tags?: string[];
  areaPath?: string;
  iterationPath?: string;
  parentLinks?: string[];
  childLinks?: string[];
  relatedLinks?: string[];
  testedByLinks?: string[];
  testsLinks?: string[];
  createdDate?: string;
  updatedDate?: string;
  raw?: unknown;
};

export type TestStep = {
  action: string;
  expectedResult: string;
};

export type TestCasePriority = 1 | 2 | 3 | 4;

export type TestCase = {
  id: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps: TestStep[];
  testData?: string;
  expectedResult?: string;
  priority?: TestCasePriority;
  testType?: string;
  automationSuitability?: string;
  tags?: string[];
  azureTestCaseId?: string;
  raw?: unknown;
};

export type FinalApprovedTestCase = Omit<TestCase, "id" | "azureTestCaseId"> & {
  localId: string;
  targetUserStoryId: string;
};

export type AzureBugCustomField = {
  referenceName: string;
  value: AzureWorkItemFieldValue;
};

export type AzureBugWorkItemInput = {
  title: string;
  reproStepsHtml: string;
  priority: 1 | 2 | 3 | 4;
  severity: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  parentStoryId?: string;
  customFields?: AzureBugCustomField[];
};

export type AzureAttachmentUpload = {
  fileName: string;
  contentType?: string;
  content: ArrayBuffer;
};

export type TestPlan = {
  id: string;
  name: string;
  raw?: unknown;
};

export type TestSuite = {
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
  children?: TestSuite[];
  raw?: unknown;
};

export type TestSuiteType = "staticTestSuite" | "requirementTestSuite" | "dynamicTestSuite" | "none";

export type AzureIdentityRef = {
  id?: string;
  displayName?: string;
  uniqueName?: string;
  descriptor?: string;
  imageUrl?: string;
  url?: string;
};

export type TestConfigurationReference = {
  id: string;
  name?: string;
};

export type AzureTestPoint = {
  id: string;
  testCaseId?: string;
  testCaseTitle?: string;
  configurationId?: string;
  configurationName?: string;
  suiteId?: string;
  suiteName?: string;
  planId?: string;
  outcome?: string;
  state?: string;
  lastUpdatedDate?: string;
  lastRunDate?: string;
  tester?: AzureIdentityRef;
  assignedTo?: AzureIdentityRef;
  raw?: unknown;
};

export type CreateTestSuiteInput = {
  projectId: string;
  testPlanId: string;
  parentSuiteId: string;
  name: string;
  suiteType?: TestSuiteType;
  requirementId?: string;
  queryString?: string;
  inheritDefaultConfigurations?: boolean;
  defaultConfigurations?: TestConfigurationReference[];
  defaultTesters?: AzureIdentityRef[];
};

export type AddSuiteTestCaseInput = {
  testCaseId: string;
  configurationIds?: string[];
};

export type UpdateTestPointInput = {
  projectId: string;
  testPlanId: string;
  testSuiteId: string;
  pointIds: string[];
  outcome?: string;
  tester?: AzureIdentityRef;
};

export type AzureDevOpsSettings = {
  organizationUrl: string;
  personalAccessToken: string;
};

export type BulkTaskTemplate = {
  title: string;
  description?: string;
  assignedTo?: string;
  originalEstimate?: number;
  copyEstimateToRemainingWork?: boolean;
};

export type BulkTaskTarget = {
  storyId: string;
  assignedTo?: string;
  originalEstimate?: number;
};

export type CreatedBulkTask = {
  storyId: string;
  taskId: string;
  title: string;
};

export type FailedBulkTask = {
  storyId: string;
  error: string;
  status: "failed" | "skipped";
};

export type BulkTaskResult = {
  storyId: string;
  status: "created" | "failed" | "skipped";
  taskId?: string;
  error?: string;
};
