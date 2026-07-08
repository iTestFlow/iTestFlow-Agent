import "server-only";

import { azureDevOpsDescriptor } from "./azure-devops/azure-devops-descriptor";
import { AzureDevOpsRestAdapter, type AzureDevOpsProjectScope } from "./azure-devops/azure-devops-client";
import type { AzureDevOpsSettings } from "./azure-devops/azure-devops-types";
import { providerConfigurationError, unsupportedProviderError } from "./core/capabilities";
import type { ProviderDescriptor, ProviderId } from "./core/provider-types";
import type { TestManagementProvider } from "./core/test-management-provider";
import type { WorkManagementProvider } from "./core/work-management-provider";

const PROVIDER_DESCRIPTORS = {
  "azure-devops": azureDevOpsDescriptor,
} satisfies Record<ProviderId, ProviderDescriptor>;

export type IntegrationProvider = WorkManagementProvider & TestManagementProvider;

export type IntegrationProviderConfig = {
  providerId: ProviderId | string;
  settings: AzureDevOpsSettings;
  projectScope?: AzureDevOpsProjectScope;
  hooks?: { onUnauthorized?: () => void };
};

export function createIntegrationProvider(config: IntegrationProviderConfig): IntegrationProvider {
  switch (config.providerId) {
    case "azure-devops":
      return new AzureDevOpsRestAdapter(config.settings, config.projectScope, config.hooks);
    default:
      throw unsupportedProviderError(config.providerId);
  }
}

export function getProviderDescriptor(providerId: ProviderId | string): ProviderDescriptor {
  if (isProviderId(providerId)) return PROVIDER_DESCRIPTORS[providerId];
  throw unsupportedProviderError(providerId);
}

export function resolveWorkspaceProviderId(workspace: { providerId?: string | null }): ProviderId {
  const providerId = workspace.providerId;
  if (!providerId) {
    throw providerConfigurationError("unknown", "Workspace integration provider is not configured.");
  }
  if (!isProviderId(providerId)) {
    throw providerConfigurationError(providerId, `Workspace integration provider is not registered: ${providerId}.`);
  }
  return providerId;
}

function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDER_DESCRIPTORS, value);
}
