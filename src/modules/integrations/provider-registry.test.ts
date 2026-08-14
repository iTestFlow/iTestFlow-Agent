import { describe, expect, it, vi } from "vitest";

const azure = vi.hoisted(() => ({
  AzureDevOpsRestAdapter: vi.fn(function MockAzureDevOpsRestAdapter(this: { args?: unknown[] }, ...args: unknown[]) {
    this.args = args;
  }),
}));
const jira = vi.hoisted(() => ({
  JiraCloudAdapter: vi.fn(function MockJiraCloudAdapter(this: { args?: unknown[] }, ...args: unknown[]) {
    this.args = args;
  }),
}));

vi.mock("./azure-devops/azure-devops-client", () => ({
  AzureDevOpsRestAdapter: azure.AzureDevOpsRestAdapter,
}));
vi.mock("./jira-cloud/jira-cloud-adapter", () => ({ JiraCloudAdapter: jira.JiraCloudAdapter }));

import {
  createIntegrationProvider,
  getProviderDescriptor,
  resolveWorkspaceProviderId,
} from "./provider-registry";
import { isIntegrationError } from "./core/integration-error";

function expectIntegrationError(action: () => unknown, code: string, message?: string) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeTruthy();
  expect(isIntegrationError(caught)).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
  if (message) expect((caught as Error).message).toBe(message);
}

describe("provider registry", () => {
  it("constructs the Azure DevOps provider with the supplied settings, scope, and hooks", () => {
    const hooks = { onUnauthorized: vi.fn() };
    const settings = { organizationUrl: "https://dev.azure.com/acme", personalAccessToken: "pat" };
    const projectScope = { azureProjectId: "project-1", azureProjectName: "Acme Project" };

    const provider = createIntegrationProvider({
      providerId: "azure-devops",
      settings,
      projectScope,
      hooks,
    });

    expect(azure.AzureDevOpsRestAdapter).toHaveBeenCalledWith(settings, projectScope, hooks);
    expect(provider).toBe(azure.AzureDevOpsRestAdapter.mock.instances[0]);
  });

  it("returns descriptors for registered providers", () => {
    expect(getProviderDescriptor("azure-devops")).toMatchObject({
      id: "azure-devops",
      name: "Azure DevOps",
    });
    expect(getProviderDescriptor("jira-cloud")).toMatchObject({
      id: "jira-cloud", name: "Jira Cloud", categories: ["work-management"],
    });
    expect(getProviderDescriptor("jira-cloud").capabilities.has("fetchWorkItems")).toBe(true);
    expect(getProviderDescriptor("jira-cloud").capabilities.has("fetchTestPlans")).toBe(false);
  });

  it("constructs every registered Jira provider descriptor", () => {
    const settings = { cloudId: "cloud-a", siteUrl: "https://quality.atlassian.net", accessToken: "access" };
    const projectScope = { jiraProjectId: "10000", jiraProjectKey: "QA", jiraProjectName: "Quality" };
    const provider = createIntegrationProvider({ providerId: "jira-cloud", settings, projectScope });
    expect(jira.JiraCloudAdapter).toHaveBeenCalledWith(settings, projectScope);
    expect(provider).toBe(jira.JiraCloudAdapter.mock.instances[0]);
  });

  it("rejects unknown provider ids during construction and descriptor lookup", () => {
    for (const action of [
      () => createIntegrationProvider({
        providerId: "jira",
        settings: { organizationUrl: "https://example.invalid", personalAccessToken: "pat" },
      } as never),
      () => getProviderDescriptor("jira"),
    ]) {
      expectIntegrationError(action, "integration_unsupported_provider", "Unsupported integration provider: jira.");
    }
  });

  it("resolves and validates workspace provider ids", () => {
    expect(resolveWorkspaceProviderId({ providerId: "azure-devops" })).toBe("azure-devops");
    expect(resolveWorkspaceProviderId({ providerId: "jira-cloud" })).toBe("jira-cloud");

    for (const workspace of [{ providerId: "jira" }, { providerId: null }, {}]) {
      expectIntegrationError(() => resolveWorkspaceProviderId(workspace), "integration_configuration");
    }
  });
});
