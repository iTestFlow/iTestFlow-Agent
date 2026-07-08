import type {
  Area,
  AttachmentUpload,
  BugWorkItemInput,
  Iteration,
  ProjectUser,
  ProjectWorkItemMetadata,
  Requirement,
  WorkItemRevision,
  WorkItemTypeField,
} from "./integration-types";
import type { ProviderConnection } from "./provider-connection";

export interface WorkManagementProvider extends ProviderConnection {
  fetchIterations(input: {
    projectId: string;
  }): Promise<Iteration[]>;

  fetchAreas(input: {
    projectId: string;
  }): Promise<Area[]>;

  fetchProjectUsers(input: {
    projectId: string;
  }): Promise<ProjectUser[]>;

  fetchProjectWorkItemMetadata(input: {
    projectId: string;
    /** Include the per-type state lists (one extra REST call per work-item type). Defaults to true. */
    includeStates?: boolean;
  }): Promise<ProjectWorkItemMetadata>;

  fetchWorkItemTypeFields(input: {
    projectId: string;
    workItemType: string;
  }): Promise<WorkItemTypeField[]>;

  fetchWorkItems(input: {
    projectId: string;
    workItemTypes?: string[];
    states?: string[];
    areaPath?: string;
    iterationPath?: string;
    assignedTo?: string;
    assignedToMe?: boolean;
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

  fetchWorkItemRevisions(input: {
    projectId: string;
    workItemTypes: string[];
    startDateTime: string;
    fields: string[];
    limit?: number;
  }): Promise<WorkItemRevision[]>;

  addWorkItemComment(input: {
    projectId: string;
    workItemId: string;
    commentBody: string;
  }): Promise<{
    success: boolean;
    commentId?: string;
    error?: string;
  }>;

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

  createBug(input: {
    projectId: string;
    bug: BugWorkItemInput;
  }): Promise<{
    success: boolean;
    azureBugId?: string;
    error?: string;
  }>;

  uploadWorkItemAttachment(input: {
    projectId: string;
    attachment: AttachmentUpload;
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
}
