export type ProviderProject = {
  id: string;
  name: string;
  url?: string;
  state?: string;
  visibility?: string;
};

export type ProviderAuthenticatedUser = {
  id?: string;
  displayName: string;
  uniqueName?: string;
  emailAddress?: string;
  imageUrl?: string;
};

export type Iteration = {
  id: string;
  name: string;
  path: string;
  startDate?: string;
  finishDate?: string;
};

export type Area = {
  id: string;
  name: string;
  path: string;
};

export type ProjectUser = {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
};

export type ProjectWorkItemMetadata = {
  workItemTypes: string[];
  states: string[];
};

export type WorkItemFieldValue = string | number | boolean;

export type WorkItemFieldType =
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

export type WorkItemTypeField = {
  name: string;
  referenceName: string;
  type?: WorkItemFieldType;
  helpText?: string;
  required?: boolean;
  alwaysRequired?: boolean;
  readOnly?: boolean;
  defaultValue?: unknown;
  allowedValues?: WorkItemFieldValue[];
};

export type Requirement = {
  id: string;
  revision?: number;
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

export type BugCustomField = {
  referenceName: string;
  value: WorkItemFieldValue;
};

export type BugWorkItemInput = {
  title: string;
  reproStepsHtml: string;
  priority: 1 | 2 | 3 | 4;
  severity: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  parentStoryId?: string;
  customFields?: BugCustomField[];
};

export type AttachmentUpload = {
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
  defaultTesters?: IdentityRef[];
  children?: TestSuite[];
  raw?: unknown;
};

export type TestSuiteType = "staticTestSuite" | "requirementTestSuite" | "dynamicTestSuite" | "none";

export type IdentityRef = {
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

export type TestPoint = {
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
  tester?: IdentityRef;
  assignedTo?: IdentityRef;
  raw?: unknown;
};

export type TestRun = {
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
  owner?: IdentityRef;
  raw?: unknown;
};

export type TestResult = {
  id: string;
  runId: string;
  testCaseId?: string;
  testCaseTitle?: string;
  outcome?: string;
  state?: string;
  startedDate?: string;
  completedDate?: string;
  durationInMs?: number;
  owner?: IdentityRef;
  comment?: string;
  errorMessage?: string;
  associatedBugIds: string[];
  raw?: unknown;
};

export type WorkItemRevision = {
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
  defaultTesters?: IdentityRef[];
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
  tester?: IdentityRef;
};
