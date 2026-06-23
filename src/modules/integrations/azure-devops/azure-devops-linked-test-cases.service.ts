import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";

export async function fetchProjectScopedLinkedTestCases(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: { actor: string; userStoryId: string },
) {
  const scope = assertProjectScope(scopeInput);
  const linkedTestCases = await adapter.fetchLinkedTestCases({
    projectId: scope.azureProjectId,
    userStoryId: input.userStoryId,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    entityType: "work_item",
    entityId: input.userStoryId,
    action: "azure_devops.fetch_linked_test_cases",
    status: "Success",
    message: `Fetched ${linkedTestCases.length} linked test cases for selected story.`,
    details: { count: linkedTestCases.length },
  });

  return linkedTestCases;
}
