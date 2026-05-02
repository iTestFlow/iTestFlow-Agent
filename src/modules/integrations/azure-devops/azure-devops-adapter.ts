import type { AzureProject, FinalApprovedTestCase, Requirement, TestCase, TestPlan, TestSuite } from "./azure-devops-types";

export interface AzureDevOpsAdapter {
  testConnection(): Promise<boolean>;

  fetchProjects(): Promise<AzureProject[]>;

  fetchWorkItems(input: {
    projectId: string;
    workItemTypes?: string[];
    areaPath?: string;
    iterationPath?: string;
  }): Promise<Requirement[]>;

  fetchWorkItemById(input: {
    projectId: string;
    workItemId: string;
  }): Promise<Requirement>;

  fetchLinkedWorkItems(input: {
    projectId: string;
    workItemId: string;
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

  createTestCase(input: {
    projectId: string;
    testCase: FinalApprovedTestCase;
  }): Promise<{
    success: boolean;
    azureTestCaseId?: string;
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

  linkTestCaseToUserStory(input: {
    projectId: string;
    userStoryId: string;
    azureTestCaseId: string;
  }): Promise<{
    success: boolean;
    error?: string;
  }>;
}
