import type { ProviderCapability } from "../core/capabilities";
import type { ProviderDescriptor } from "../core/provider-types";

const capabilities = [
  "testConnection", "fetchAuthenticatedUser", "fetchProjects",
  "fetchIterations", "fetchAreas", "fetchProjectUsers", "fetchProjectWorkItemMetadata",
  "fetchWorkItemTypeFields", "fetchWorkItems", "fetchWorkItemById", "fetchWorkItemsByIds",
  "fetchLinkedWorkItems", "fetchLinkedRequirementWorkItems",
  "addWorkItemComment", "createChildTask", "createBug", "buildWorkItemWebUrl",
] satisfies ProviderCapability[];

export const jiraCloudDescriptor: ProviderDescriptor = {
  id: "jira-cloud",
  name: "Jira Cloud",
  categories: ["work-management"],
  capabilities: new Set(capabilities),
};
