export type AzureProject = {
  id: string;
  name: string;
  url?: string;
  state?: string;
  visibility?: string;
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

export type TestCase = {
  id: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps: TestStep[];
  testData?: string;
  expectedResult?: string;
  priority?: string;
  severity?: string;
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
  raw?: unknown;
};

export type AzureDevOpsSettings = {
  organizationUrl: string;
  personalAccessToken: string;
};
