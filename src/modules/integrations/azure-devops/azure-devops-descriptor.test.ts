import { describe, expect, it } from "vitest";

import { azureDevOpsCapabilities, azureDevOpsDescriptor } from "./azure-devops-descriptor";

describe("azureDevOpsDescriptor", () => {
  it("declares Azure DevOps as both work and test management", () => {
    expect(azureDevOpsDescriptor).toMatchObject({
      id: "azure-devops",
      name: "Azure DevOps",
      categories: ["work-management", "test-management"],
    });
  });

  it("declares every current provider capability", () => {
    // Compile-time exhaustiveness lives in azure-devops-descriptor.ts; this count is the runtime tripwire.
    expect(azureDevOpsDescriptor.capabilities.size).toBe(36);
    expect(Object.keys(azureDevOpsCapabilities)).toHaveLength(36);
    for (const capability of Object.keys(azureDevOpsCapabilities)) {
      expect(azureDevOpsDescriptor.capabilities.has(capability as never)).toBe(true);
    }
  });
});
