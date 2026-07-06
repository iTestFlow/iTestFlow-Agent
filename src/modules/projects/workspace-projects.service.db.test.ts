import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { WorkflowAuthError, type WorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { resolveProjectScope, upsertWorkspaceProject } from "@/modules/projects/workspace-projects.service";
import { describeDb } from "@/test/db";

const WS_A = "ws_project_anchor_a";
const WS_B = "ws_project_anchor_b";
const ORG_A_URL = "https://dev.azure.com/project-anchor-a";
const ORG_B_URL = "https://dev.azure.com/project-anchor-b";

const ctxA: WorkflowContext = {
  userId: "user_project_anchor",
  workspace: {
    id: WS_A,
    name: "Project Anchor A",
    azureOrgName: "project-anchor-a",
    azureOrgUrl: ORG_A_URL,
  },
};

const ctxB: WorkflowContext = {
  userId: "user_project_anchor",
  workspace: {
    id: WS_B,
    name: "Project Anchor B",
    azureOrgName: "project-anchor-b",
    azureOrgUrl: ORG_B_URL,
  },
};

async function cleanup() {
  await sqlRun(`DELETE FROM projects WHERE workspace_id IN (@workspaceA, @workspaceB)`, {
    workspaceA: WS_A,
    workspaceB: WS_B,
  });
  await sqlRun(`DELETE FROM projects WHERE azure_organization_url IN (@orgA, @orgB)`, {
    orgA: ORG_A_URL,
    orgB: ORG_B_URL,
  });
  await sqlRun(`DELETE FROM workspaces WHERE id IN (@workspaceA, @workspaceB)`, {
    workspaceA: WS_A,
    workspaceB: WS_B,
  });
}

async function insertWorkspace(ctx: WorkflowContext) {
  await sqlRun(
    `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
     VALUES (@id, @name, @orgName, @orgUrl, 'active', 't', 't')`,
    {
      id: ctx.workspace.id,
      name: ctx.workspace.name,
      orgName: ctx.workspace.azureOrgName,
      orgUrl: ctx.workspace.azureOrgUrl,
    },
  );
}

describeDb("workspace project anchors (DB-backed)", () => {
  beforeAll(async () => {
    await cleanup();
    await insertWorkspace(ctxA);
    await insertWorkspace(ctxB);
  });

  afterAll(async () => {
    await cleanup();
    await resetDatabaseForTests();
  });

  it("persists a workspace-owned project anchor and returns trusted scope", async () => {
    const scope = await upsertWorkspaceProject(ctxA, {
      azureProjectId: "az_project_alpha",
      azureProjectName: "Project Alpha",
    });

    expect(scope).toEqual({
      projectId: "az_project_alpha",
      azureProjectId: "az_project_alpha",
      azureProjectName: "Project Alpha",
      azureOrganizationUrl: ORG_A_URL,
      workspaceId: WS_A,
    });

    const row = await sqlGet<{
      id: string;
      azure_project_name: string;
      azure_organization_url: string;
      workspace_id: string;
    }>(
      `SELECT id, azure_project_name, azure_organization_url, workspace_id
       FROM projects
       WHERE id = @id`,
      { id: "az_project_alpha" },
    );
    expect(row).toMatchObject({
      id: "az_project_alpha",
      azure_project_name: "Project Alpha",
      azure_organization_url: ORG_A_URL,
      workspace_id: WS_A,
    });
  });

  it("resolves by Azure project id and ignores forged client project details", async () => {
    await upsertWorkspaceProject(ctxA, {
      azureProjectId: "az_project_beta",
      azureProjectName: "Project Beta",
    });

    const resolved = await resolveProjectScope(ctxA, {
      projectId: "client_forged_project_id",
      azureProjectId: "az_project_beta",
      azureProjectName: "Client Forged Name",
      azureOrganizationUrl: "https://dev.azure.com/forged",
      workspaceId: "ws_forged",
    });

    expect(resolved).toEqual({
      projectId: "az_project_beta",
      azureProjectId: "az_project_beta",
      azureProjectName: "Project Beta",
      azureOrganizationUrl: ORG_A_URL,
      workspaceId: WS_A,
    });
  });

  it("rejects a project anchored to another workspace before falling back to Azure verification", async () => {
    await upsertWorkspaceProject(ctxB, {
      azureProjectId: "az_project_outside",
      azureProjectName: "Outside Project",
    });

    await expect(
      resolveProjectScope(ctxA, {
        projectId: "az_project_outside",
        azureProjectId: "az_project_outside",
        azureProjectName: "Outside Project",
        azureOrganizationUrl: ORG_B_URL,
        workspaceId: WS_A,
      }),
    ).rejects.toMatchObject({
      name: "WorkflowAuthError",
      status: 403,
    } satisfies Partial<WorkflowAuthError>);
  });
});
