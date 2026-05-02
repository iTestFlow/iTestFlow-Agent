import "server-only";

import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { AzureDevOpsRestAdapter } from "./azure-devops-client";

export function getConfiguredAzureDevOpsAdapter() {
  const settings = getEffectiveRuntimeSettings();
  const organizationUrl = settings?.azureDevOps.organizationUrl;
  const personalAccessToken = settings?.azureDevOps.personalAccessToken;

  if (!organizationUrl || !personalAccessToken) {
    throw new Error(
      "Azure DevOps is not configured. Use the Initial Configuration screen or set AZURE_DEVOPS_ORG_URL and AZURE_DEVOPS_PAT in .env.local.",
    );
  }

  return new AzureDevOpsRestAdapter({ organizationUrl, personalAccessToken });
}

export function getConfiguredAzureDevOpsOrganizationUrl() {
  return getEffectiveRuntimeSettings()?.azureDevOps.organizationUrl ?? process.env.AZURE_DEVOPS_ORG_URL;
}
