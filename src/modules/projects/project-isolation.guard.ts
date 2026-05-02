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
