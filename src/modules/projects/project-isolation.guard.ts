import "server-only";

import { z } from "zod";

export const ProjectScopeSchema = z.object({
  projectId: z.string().min(1),
  azureProjectId: z.string().min(1),
  azureProjectName: z.string().min(1),
  azureOrganizationUrl: z.string().url(),
});

export type ProjectScope = z.infer<typeof ProjectScopeSchema>;

export class ProjectIsolationError extends Error {
  constructor(message = "Please select an Azure DevOps project before running this action.") {
    super(message);
    this.name = "ProjectIsolationError";
  }
}

/**
 * Single canonical message for a work item ID that cannot be used in the active
 * project — whether because it belongs to another project, does not exist, or
 * the account lacks permission. These cases are intentionally indistinguishable
 * so the wording is consistent and we never confirm that an ID exists in some
 * other project. Used by the Azure DevOps client (cross-project rejection) and
 * by routes mapping Azure 404 / permission errors.
 */
export function workItemNotInProjectMessage(workItemId: string | number) {
  return `Work item ${workItemId} was not found in the selected project, or you do not have permission to access it. Check the Work Item ID, selected project, and access permissions.`;
}

export function assertProjectScope(input: unknown): ProjectScope {
  const result = ProjectScopeSchema.safeParse(input);
  if (!result.success) {
    throw new ProjectIsolationError();
  }
  return result.data;
}

export function assertSameAzureProject(scope: ProjectScope, azureProjectId: string) {
  if (scope.azureProjectId !== azureProjectId) {
    throw new ProjectIsolationError("The selected Azure DevOps project does not match the target record.");
  }
}
