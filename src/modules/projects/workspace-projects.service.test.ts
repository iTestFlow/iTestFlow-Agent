import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserWorkManagementProviderOrgLevel: vi.fn(),
  resolveWorkspaceProviderId: vi.fn(),
  upsertJiraProjectMapping: vi.fn(),
  sqlGet: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>()),
  getUserWorkManagementProviderOrgLevel: mocks.getUserWorkManagementProviderOrgLevel,
}));
vi.mock("@/modules/integrations/provider-registry", () => ({
  resolveWorkspaceProviderId: mocks.resolveWorkspaceProviderId,
}));
vi.mock("./jira-project-mapping.service", () => ({ upsertJiraProjectMapping: mocks.upsertJiraProjectMapping }));
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  nowIso: () => "2026-08-13T00:00:00.000Z",
  sqlGet: mocks.sqlGet,
}));

import { resolveProjectScope, verifyAndUpsertWorkspaceProject } from "./workspace-projects.service";

describe("verifyAndUpsertWorkspaceProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveWorkspaceProviderId.mockReturnValue("jira-cloud");
    mocks.getUserWorkManagementProviderOrgLevel.mockResolvedValue({
      fetchProjects: vi.fn().mockResolvedValue([{ id: "10000", key: "QA", name: "Quality" }]),
    });
    mocks.upsertJiraProjectMapping.mockResolvedValue("project-local");
  });

  it("verifies and anchors a Jira project through the provider-neutral discovery path", async () => {
    const context = {
      userId: "user-1",
      workspace: {
        id: "ws-jira", name: "Quality", providerId: "jira-cloud",
        azureOrgName: "", azureOrgUrl: "", providerSiteId: "cloud-a",
        providerSiteName: "Quality", providerSiteUrl: "https://quality.atlassian.net",
      },
    };

    await expect(verifyAndUpsertWorkspaceProject(context, "10000")).resolves.toMatchObject({
      projectId: "project-local", providerProjectId: "10000", providerProjectKey: "QA",
      azureOrganizationUrl: "https://quality.atlassian.net", workspaceId: "ws-jira",
    });
    expect(mocks.upsertJiraProjectMapping).toHaveBeenCalledWith({
      workspaceId: "ws-jira", providerId: "jira-cloud", jiraProjectId: "10000",
      jiraProjectKey: "QA", jiraProjectName: "Quality",
    });
  });

  it("does not treat a site-local Jira project id as a global cross-workspace collision", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined);
    const context = {
      userId: "user-1",
      workspace: {
        id: "ws-jira", name: "Quality", providerId: "jira-cloud",
        azureOrgName: "", azureOrgUrl: "", providerSiteId: "cloud-b",
        providerSiteName: "Quality", providerSiteUrl: "https://quality-b.atlassian.net",
      },
    };

    await resolveProjectScope(context, {
      projectId: "untrusted-client-id", azureProjectId: "10000", azureProjectName: "Quality",
      azureOrganizationUrl: "https://quality-b.atlassian.net", providerProjectId: "10000",
      providerProjectKey: "QA", providerProjectName: "Quality",
    });

    const [collisionSql, collisionParams] = mocks.sqlGet.mock.calls[1];
    expect(collisionSql).toContain("@providerId = 'azure-devops'");
    expect(collisionParams).toMatchObject({ providerId: "jira-cloud" });
  });
});
