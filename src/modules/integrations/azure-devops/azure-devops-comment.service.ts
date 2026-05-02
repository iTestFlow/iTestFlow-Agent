import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";

export async function pushApprovedRequirementComment(
  adapter: AzureDevOpsAdapter,
  scopeInput: ProjectScope,
  input: { workItemId: string; commentBody: string },
) {
  const scope = assertProjectScope(scopeInput);
  const result = await adapter.addWorkItemComment({
    projectId: scope.azureProjectId,
    workItemId: input.workItemId,
    commentBody: input.commentBody,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    entityType: "work_item",
    entityId: input.workItemId,
    action: "azure_devops.push_requirement_comment",
    status: result.success ? "Success" : "Failed",
    message: result.success ? "Approved requirement analysis comment pushed." : "Requirement comment push failed.",
    details: result,
  });

  return result;
}
