import "server-only";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  getUserAzureAdapterOrgLevel,
  type WorkflowContext,
  WorkflowAuthError,
} from "@/modules/credentials/scoped-resolution.service";
import { nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

type ProjectRow = {
  id: string;
  azure_project_id: string;
  azure_project_name: string;
  azure_organization_url: string;
  workspace_id: string | null;
};

export type WorkspaceProjectInput = {
  azureProjectId: string;
  azureProjectName: string;
};

function trustedScope(ctx: WorkflowContext, row: ProjectRow): ProjectScope {
  return {
    projectId: row.id,
    azureProjectId: row.azure_project_id,
    azureProjectName: row.azure_project_name,
    azureOrganizationUrl: ctx.workspace.azureOrgUrl,
    workspaceId: ctx.workspace.id,
  };
}

export async function upsertWorkspaceProject(
  ctx: WorkflowContext,
  input: WorkspaceProjectInput,
): Promise<ProjectScope> {
  const azureProjectId = input.azureProjectId.trim();
  const azureProjectName = input.azureProjectName.trim() || azureProjectId;
  if (!azureProjectId) throw new WorkflowAuthError("Azure DevOps project id is required.", 400);
  const now = nowIso();

  const row = await sqlGet<ProjectRow>(
    `INSERT INTO projects (
       id, azure_project_id, azure_project_name, azure_organization_url,
       name, status, workspace_id, created_at, updated_at
     ) VALUES (
       @azureProjectId, @azureProjectId, @azureProjectName, @orgUrl,
       @azureProjectName, 'active', @workspaceId, @now, @now
     )
     ON CONFLICT (azure_organization_url, azure_project_id)
     DO UPDATE SET
       id = EXCLUDED.id,
       azure_project_name = EXCLUDED.azure_project_name,
       name = EXCLUDED.name,
       status = 'active',
       workspace_id = EXCLUDED.workspace_id,
       updated_at = EXCLUDED.updated_at
     RETURNING id, azure_project_id, azure_project_name, azure_organization_url, workspace_id`,
    {
      azureProjectId,
      azureProjectName,
      orgUrl: ctx.workspace.azureOrgUrl,
      workspaceId: ctx.workspace.id,
      now,
    },
  );
  if (!row) throw new WorkflowAuthError("Unable to save the selected Azure DevOps project.", 500);
  return trustedScope(ctx, row);
}

async function findWorkspaceProject(ctx: WorkflowContext, scope: ProjectScope): Promise<ProjectRow | undefined> {
  return sqlGet<ProjectRow>(
    `SELECT id, azure_project_id, azure_project_name, azure_organization_url, workspace_id
     FROM projects
     WHERE workspace_id = @workspaceId
       AND (id = @projectId OR azure_project_id = @azureProjectId)
     LIMIT 1`,
    {
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );
}

async function projectExistsOutsideWorkspace(ctx: WorkflowContext, scope: ProjectScope): Promise<boolean> {
  const row = await sqlGet<{ id: string }>(
    `SELECT id FROM projects
     WHERE (id = @projectId OR azure_project_id = @azureProjectId)
       AND workspace_id IS NOT NULL
       AND workspace_id <> @workspaceId
     LIMIT 1`,
    {
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );
  return Boolean(row);
}

export async function verifyAndUpsertWorkspaceProject(
  ctx: WorkflowContext,
  azureProjectId: string,
): Promise<ProjectScope> {
  const adapter = await getUserAzureAdapterOrgLevel(ctx);
  const projects = await adapter.fetchProjects();
  const project = projects.find((item) => item.id === azureProjectId);
  if (!project) {
    throw new WorkflowAuthError(
      "The selected Azure DevOps project was not found in this workspace, or you do not have permission to access it.",
      404,
    );
  }
  return upsertWorkspaceProject(ctx, {
    azureProjectId: project.id,
    azureProjectName: project.name,
  });
}

export async function resolveProjectScope(ctx: WorkflowContext, clientScope: ProjectScope): Promise<ProjectScope> {
  const existing = await findWorkspaceProject(ctx, clientScope);
  if (existing) return trustedScope(ctx, existing);

  if (await projectExistsOutsideWorkspace(ctx, clientScope)) {
    throw new WorkflowAuthError("The selected Azure DevOps project does not belong to this workspace.", 403);
  }

  const candidateId = clientScope.azureProjectId || clientScope.projectId;
  return verifyAndUpsertWorkspaceProject(ctx, candidateId);
}
