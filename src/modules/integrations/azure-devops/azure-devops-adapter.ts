import type {
  AddSuiteTestCaseInput,
  AzureAuthenticatedUser,
  AzureArea,
  AzureAttachmentUpload,
  AzureBugWorkItemInput,
  AzureIteration,
  AzureProject,
  AzureProjectUser,
  AzureProjectWorkItemMetadata,
  AzureTestPoint,
  AzureTestResult,
  AzureTestRun,
  AzureWorkItemRevision,
  AzureWorkItemTypeField,
  CreateTestSuiteInput,
  FinalApprovedTestCase,
  Requirement,
  TestCase,
  TestPlan,
  TestSuite,
  UpdateTestPointInput,
} from "./azure-devops-types";

export interface AzureDevOpsAdapter {
  testConnection(): Promise<boolean>;

  fetchAuthenticatedUser(): Promise<AzureAuthenticatedUser>;

  fetchProjects(): Promise<AzureProject[]>;

  fetchIterations(input: {
    projectId: string;
  }): Promise<AzureIteration[]>;

  fetchAreas(input: {
    projectId: string;
  }): Promise<AzureArea[]>;

  fetchProjectUsers(input: {
    projectId: string;
  }): Promise<AzureProjectUser[]>;

  fetchProjectWorkItemMetadata(input: {
    projectId: string;
  }): Promise<AzureProjectWorkItemMetadata>;

  fetchWorkItemTypeFields(input: {
    projectId: string;
    workItemType: string;
  }): Promise<AzureWorkItemTypeField[]>;

  fetchWorkItems(input: {
    projectId: string;
    workItemTypes?: string[];
    states?: string[];
    areaPath?: string;
    iterationPath?: string;
    assignedTo?: string;
    limit?: number;
  }): Promise<Requirement[]>;

  fetchWorkItemById(input: {
    projectId: string;
    workItemId: string;
  }): Promise<Requirement>;

  fetchWorkItemsByIds(input: {
    projectId: string;
    workItemIds: string[];
  }): Promise<Requirement[]>;

  fetchLinkedWorkItems(input: {
    projectId: string;
    workItemId: string;
  }): Promise<Requirement[]>;

  fetchLinkedRequirementWorkItems(input: {
    projectId: string;
    workItemId: string;
    workItemTypes: string[];
  }): Promise<Requirement[]>;

  fetchLinkedTestCases(input: {
    projectId: string;
    userStoryId: string;
  }): Promise<TestCase[]>;

  addWorkItemComment(input: {
    projectId: string;
    workItemId: string;
    commentBody: string;
  }): Promise<{
    success: boolean;
    commentId?: string;
    error?: string;
  }>;

  fetchTestPlans(input: {
    projectId: string;
  }): Promise<TestPlan[]>;

  fetchTestSuites(input: {
    projectId: string;
    testPlanId: string;
  }): Promise<TestSuite[]>;

  fetchTestSuiteTree(input: {
    projectId: string;
    testPlanId: string;
  }): Promise<TestSuite[]>;

  createTestSuite(input: CreateTestSuiteInput): Promise<{
    success: boolean;
    suite?: TestSuite;
    error?: string;
  }>;

  deleteTestSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;

  fetchTestPoints(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
  }): Promise<AzureTestPoint[]>;

  fetchTestRuns(input: {
    projectId: string;
    testPlanId?: string;
    limit?: number;
  }): Promise<AzureTestRun[]>;

  fetchTestResults(input: {
    projectId: string;
    runId: string;
    limit?: number;
  }): Promise<AzureTestResult[]>;

  fetchWorkItemRevisions(input: {
    projectId: string;
    workItemTypes: string[];
    startDateTime: string;
    fields: string[];
    limit?: number;
  }): Promise<AzureWorkItemRevision[]>;

  addTestCasesToSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
    testCases: AddSuiteTestCaseInput[];
  }): Promise<{
    success: boolean;
    addedCount: number;
    errors: Array<{ testCaseId: string; error: string }>;
  }>;

  updateTestPoints(input: UpdateTestPointInput): Promise<{
    success: boolean;
    updatedPoints?: AzureTestPoint[];
    error?: string;
  }>;

  createTestCase(input: {
    projectId: string;
    testCase: FinalApprovedTestCase;
  }): Promise<{
    success: boolean;
    azureTestCaseId?: string;
    error?: string;
  }>;

  createBug(input: {
    projectId: string;
    bug: AzureBugWorkItemInput;
  }): Promise<{
    success: boolean;
    azureBugId?: string;
    error?: string;
  }>;

  uploadWorkItemAttachment(input: {
    projectId: string;
    attachment: AzureAttachmentUpload;
  }): Promise<{
    success: boolean;
    attachmentUrl?: string;
    error?: string;
  }>;

  attachFileToWorkItem(input: {
    projectId: string;
    workItemId: string;
    attachmentUrl: string;
    fileName: string;
    comment?: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;

  buildWorkItemWebUrl(input: {
    projectId: string;
    projectName?: string;
    workItemId: string;
  }): string;

  createChildTask(input: {
    projectId: string;
    parentStoryId: string;
    title: string;
    description?: string;
    assignedTo?: string;
    originalEstimate?: number;
    copyEstimateToRemainingWork?: boolean;
    areaPath?: string;
    iterationPath?: string;
  }): Promise<{
    success: boolean;
    azureTaskId?: string;
    error?: string;
  }>;

  addTestCaseToSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
    azureTestCaseId: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;

  createRequirementBasedSuite(input: {
    projectId: string;
    testPlanId: string;
    parentSuiteId: string;
    requirementId: string;
    name: string;
  }): Promise<{
    success: boolean;
    suite?: TestSuite;
    error?: string;
  }>;

  linkTestCaseToUserStory(input: {
    projectId: string;
    userStoryId: string;
    azureTestCaseId: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;

  linkTestCaseToWorkItem(input: {
    projectId: string;
    workItemId: string;
    azureTestCaseId: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;
}
