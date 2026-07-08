import type {
  AddSuiteTestCaseInput,
  CreateTestSuiteInput,
  FinalApprovedTestCase,
  TestCase,
  TestPlan,
  TestPoint,
  TestResult,
  TestRun,
  TestSuite,
  UpdateTestPointInput,
} from "./integration-types";
import type { ProviderConnection } from "./provider-connection";

export interface TestManagementProvider extends ProviderConnection {
  fetchLinkedTestCases(input: {
    projectId: string;
    userStoryId: string;
  }): Promise<TestCase[]>;

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
  }): Promise<TestPoint[]>;

  fetchTestRuns(input: {
    projectId: string;
    testPlanId?: string;
    limit?: number;
  }): Promise<TestRun[]>;

  fetchTestResults(input: {
    projectId: string;
    runId: string;
    limit?: number;
  }): Promise<TestResult[]>;

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

  addTestCaseToSuite(input: {
    projectId: string;
    testPlanId: string;
    testSuiteId: string;
    azureTestCaseId: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;

  updateTestPoints(input: UpdateTestPointInput): Promise<{
    success: boolean;
    updatedPoints?: TestPoint[];
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
