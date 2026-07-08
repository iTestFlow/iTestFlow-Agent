import { describe, expectTypeOf, it } from "vitest";

import type { AzureDevOpsAdapter } from "./azure-devops/azure-devops-adapter";
import { AzureDevOpsRestAdapter } from "./azure-devops/azure-devops-client";
import { fakeAzureAdapter } from "@/test/factories";
import type { TestManagementProvider } from "./core/test-management-provider";
import type { WorkManagementProvider } from "./core/work-management-provider";

describe("provider contracts", () => {
  it("keeps the Azure adapter alias assignable to both provider ports", () => {
    expectTypeOf<AzureDevOpsAdapter>().toMatchTypeOf<WorkManagementProvider & TestManagementProvider>();
    expectTypeOf<WorkManagementProvider & TestManagementProvider>().toMatchTypeOf<AzureDevOpsAdapter>();
  });

  it("keeps the REST adapter and fake adapter assignable to both ports", () => {
    expectTypeOf<AzureDevOpsRestAdapter>().toMatchTypeOf<WorkManagementProvider>();
    expectTypeOf<AzureDevOpsRestAdapter>().toMatchTypeOf<TestManagementProvider>();
    expectTypeOf(fakeAzureAdapter()).toMatchTypeOf<WorkManagementProvider>();
    expectTypeOf(fakeAzureAdapter()).toMatchTypeOf<TestManagementProvider>();
  });
});
