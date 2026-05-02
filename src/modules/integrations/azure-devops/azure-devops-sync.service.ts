import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "./azure-devops-adapter";

export async function syncAzureDevOpsWorkItems(adapter: AzureDevOpsAdapter, scopeInput: ProjectScope) {
  const scope = assertProjectScope(scopeInput);
  const workItems = await adapter.fetchWorkItems({ projectId: scope.azureProjectId });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "azure_devops.sync_work_items",
    status: "Success",
    message: `Fetched ${workItems.length} work items from selected Azure DevOps project.`,
    details: { count: workItems.length },
  });

  return {
    fetchedCount: workItems.length,
    indexedCount: workItems.length,
    workItems,
  };
}
