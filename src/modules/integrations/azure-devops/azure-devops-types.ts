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

export type AzureProjectUser = {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
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

export type TestPlan = {
  id: string;
  name: string;
  raw?: unknown;
};

export type TestSuite = {
  id: string;
  name: string;
  planId: string;
  suiteType?: string;
  requirementId?: string;
  raw?: unknown;
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
