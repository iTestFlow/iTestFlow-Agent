import { describe, expect, it } from "vitest";

import type { ProviderDescriptor } from "./provider-types";
import { assertCapability, hasCapability, providerConfigurationError, unsupportedProviderError } from "./capabilities";
import { isIntegrationError } from "./integration-error";

const descriptor: ProviderDescriptor = {
  id: "azure-devops",
  name: "Azure DevOps",
  categories: ["work-management", "test-management"],
  capabilities: new Set(["fetchProjects", "fetchWorkItems"]),
};

describe("capabilities", () => {
  it("checks capabilities by provider method name", () => {
    expect(hasCapability(descriptor, "fetchProjects")).toBe(true);
    expect(hasCapability(descriptor, "fetchTestPlans")).toBe(false);
  });

  it("throws an IntegrationError for unsupported capabilities", () => {
    expect(() => assertCapability(descriptor, "fetchProjects")).not.toThrow();
    expect(() => assertCapability(descriptor, "fetchTestPlans")).toThrow("Azure DevOps does not support fetchTestPlans.");

    try {
      assertCapability(descriptor, "fetchTestPlans");
    } catch (error) {
      expect(isIntegrationError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("integration_unsupported_capability");
    }
  });

  it("normalizes provider and configuration failures", () => {
    const unsupported = unsupportedProviderError("unknown");
    const configuration = providerConfigurationError("unknown", "Workspace provider is not registered.");

    expect(unsupported.code).toBe("integration_unsupported_provider");
    expect(unsupported.message).toBe("Unsupported integration provider: unknown.");
    expect(configuration.code).toBe("integration_configuration");
    expect(configuration.message).toBe("Workspace provider is not registered.");
  });
});
