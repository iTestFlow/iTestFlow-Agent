import type { ProviderCapability } from "../core/capabilities";
import type { ProviderDescriptor } from "../core/provider-types";

const AZURE_DEVOPS_CAPABILITIES: Record<ProviderCapability, true> = {
  testConnection: true,
  fetchAuthenticatedUser: true,
  fetchProjects: true,
  fetchIterations: true,
  fetchAreas: true,
  fetchProjectUsers: true,
  fetchProjectWorkItemMetadata: true,
  fetchWorkItemTypeFields: true,
  fetchWorkItems: true,
  fetchWorkItemById: true,
  fetchWorkItemsByIds: true,
  fetchLinkedWorkItems: true,
  fetchLinkedRequirementWorkItems: true,
  fetchWorkItemRevisions: true,
  addWorkItemComment: true,
  createChildTask: true,
  createBug: true,
  uploadWorkItemAttachment: true,
  attachFileToWorkItem: true,
  buildWorkItemWebUrl: true,
  fetchLinkedTestCases: true,
  fetchTestPlans: true,
  fetchTestSuites: true,
  fetchTestSuiteTree: true,
  createTestSuite: true,
  deleteTestSuite: true,
  fetchTestPoints: true,
  fetchTestRuns: true,
  fetchTestResults: true,
  addTestCasesToSuite: true,
  addTestCaseToSuite: true,
  updateTestPoints: true,
  createTestCase: true,
  createRequirementBasedSuite: true,
  linkTestCaseToUserStory: true,
  linkTestCaseToWorkItem: true,
};

export const azureDevOpsDescriptor: ProviderDescriptor = {
  id: "azure-devops",
  name: "Azure DevOps",
  categories: ["work-management", "test-management"],
  capabilities: new Set(Object.keys(AZURE_DEVOPS_CAPABILITIES) as ProviderCapability[]),
};

export const azureDevOpsCapabilities = AZURE_DEVOPS_CAPABILITIES;
