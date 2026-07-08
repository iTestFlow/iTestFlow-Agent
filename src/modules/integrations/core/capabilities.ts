import { IntegrationError } from "./integration-error";
import type { ProviderDescriptor, ProviderId } from "./provider-types";
import type { ProviderConnection } from "./provider-connection";
import type { TestManagementProvider } from "./test-management-provider";
import type { WorkManagementProvider } from "./work-management-provider";

export type ProviderConnectionCapability = keyof ProviderConnection;
export type WorkManagementCapability = keyof WorkManagementProvider;
export type TestManagementCapability = keyof TestManagementProvider;
export type ProviderCapability = WorkManagementCapability | TestManagementCapability;

export function hasCapability(
  descriptor: Pick<ProviderDescriptor, "capabilities">,
  capability: ProviderCapability,
) {
  return descriptor.capabilities.has(capability);
}

export function assertCapability(
  descriptor: Pick<ProviderDescriptor, "id" | "name" | "capabilities">,
  capability: ProviderCapability,
): void {
  if (hasCapability(descriptor, capability)) return;
  throw new IntegrationError({
    providerId: descriptor.id,
    code: "integration_unsupported_capability",
    message: `${descriptor.name} does not support ${capability}.`,
  });
}

export function unsupportedProviderError(providerId: string) {
  return new IntegrationError({
    providerId,
    code: "integration_unsupported_provider",
    message: `Unsupported integration provider: ${providerId}.`,
  });
}

export function providerConfigurationError(providerId: ProviderId | string, message: string) {
  return new IntegrationError({
    providerId,
    code: "integration_configuration",
    message,
  });
}
