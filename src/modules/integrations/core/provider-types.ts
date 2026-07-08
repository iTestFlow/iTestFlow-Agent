import type { ProviderCapability } from "./capabilities";

export type ProviderId = "azure-devops";

export type ProviderCategory = "work-management" | "test-management";

export type ProviderDescriptor = {
  id: ProviderId;
  name: string;
  categories: readonly ProviderCategory[];
  capabilities: ReadonlySet<ProviderCapability>;
};
