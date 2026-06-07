import "server-only";

import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { AzureDevOpsRestAdapter } from "./azure-devops-client";

function resolveAzureDevOpsSettings() {
  const settings = getEffectiveRuntimeSettings();
  const organizationUrl = settings?.azureDevOps.organizationUrl;
  const personalAccessToken = settings?.azureDevOps.personalAccessToken;

  if (!organizationUrl || !personalAccessToken) {
    throw new Error(
      "Azure DevOps is not configured. Use the Initial Configuration screen or set AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT in .env.local.",
    );
  }

  return { organizationUrl, personalAccessToken };
}

/**
 * Org-level adapter with NO bound project scope. Use ONLY for organization-wide
 * operations that run before/independent of project selection: listing projects,
 * the authenticated profile, and connection tests. For any work that touches a
 * selected project's work items, test plans, or suites, use
 * getProjectScopedAzureDevOpsAdapter so by-ID reads/writes are isolated.
 */
export function getConfiguredAzureDevOpsAdapter() {
  return new AzureDevOpsRestAdapter(resolveAzureDevOpsSettings());
}

/**
 * Project-scoped adapter. Binds the active project identity so every by-ID work
 * item read/write and test-plan/suite operation is validated against this
 * project. Azure DevOps ignores the project segment in by-ID URLs, so this
 * binding is what actually enforces project isolation.
 */
export function getProjectScopedAzureDevOpsAdapter(scope: ProjectScope) {
  return new AzureDevOpsRestAdapter(resolveAzureDevOpsSettings(), {
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
  });
}

export function getConfiguredAzureDevOpsOrganizationUrl() {
  return getEffectiveRuntimeSettings()?.azureDevOps.organizationUrl ?? process.env.AZURE_DEVOPS_ORG_URL;
}
