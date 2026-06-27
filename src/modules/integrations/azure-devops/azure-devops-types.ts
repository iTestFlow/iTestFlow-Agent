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
  emailAddress?: string;
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

export type AzureProjectWorkItemMetadata = {
  workItemTypes: string[];
  states: string[];
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
  /**
   * The work item's true owning project NAME, read from System.TeamProject.
   * Azure DevOps ignores the project segment in by-ID URLs, so this is the
   * only reliable signal of which project a fetched work item actually belongs
   * to. Used to enforce project isolation; may be undefined for older payloads.
   */
  teamProject?: string;
  workItemType: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  state?: string;
  assignedTo?: string;
  priority?: number;
  severity?: string;
  tags?: string[];
  areaPath?: string;
  iterationPath?: string;
  originalEstimate?: number;
  remainingWork?: number;
  completedWork?: number;
  dueDate?: string;
  storyPoints?: number;
  parentLinks?: string[];
  childLinks?: string[];
  relatedLinks?: string[];
  testedByLinks?: string[];
  testsLinks?: string[];
  createdDate?: string;
  closedDate?: string;
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

export type AzureTestRun = {
  id: string;
  name: string;
  state?: string;
  planId?: string;
  iteration?: string;
  isAutomated?: boolean;
  startedDate?: string;
  completedDate?: string;
  createdDate?: string;
  lastUpdatedDate?: string;
  totalTests?: number;
  passedTests?: number;
  incompleteTests?: number;
  notApplicableTests?: number;
  unanalyzedTests?: number;
  owner?: AzureIdentityRef;
  raw?: unknown;
};

export type AzureTestResult = {
  id: string;
  runId: string;
  testCaseId?: string;
  testCaseTitle?: string;
  outcome?: string;
  state?: string;
  startedDate?: string;
  completedDate?: string;
  durationInMs?: number;
  owner?: AzureIdentityRef;
  comment?: string;
  errorMessage?: string;
  associatedBugIds: string[];
  raw?: unknown;
};

export type AzureWorkItemRevision = {
  workItemId: string;
  revision: number;
  revisedDate?: string;
  workItemType?: string;
  title?: string;
  state?: string;
  severity?: string;
  priority?: number;
  assignedTo?: string;
  createdDate?: string;
  closedDate?: string;
  areaPath?: string;
  iterationPath?: string;
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
