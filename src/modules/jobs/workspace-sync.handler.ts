import "server-only";

import { sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { resolveWorkspaceSyncPat } from "@/modules/credentials/credential.service";
import { createIntegrationProvider } from "@/modules/integrations/provider-registry";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import { enqueueJob, type Job } from "./job-queue.service";

export const WORKSPACE_CONTEXT_SYNC = "workspace_context_sync";

/**
 * Scheduled Azure DevOps context sync for one workspace project. Runs in the
 * worker with NO logged-in user: it uses the WORKSPACE sync credential (a service
 * account / admin PAT marked for sync), never a user's interactive PAT. The
 * project and org are resolved server-side from the workspace-scoped projects row.
 */
export async function runWorkspaceContextSync(job: Job): Promise<void> {
  if (!job.workspaceId) throw new Error("workspace_context_sync requires a workspaceId.");
  const projectId = typeof job.payload.projectId === "string" ? job.payload.projectId : "";
  if (!projectId) throw new Error("workspace_context_sync payload requires projectId.");

  const project = await sqlGet<{
    azure_project_id: string;
    azure_project_name: string;
    azure_organization_url: string;
    provider_id: string;
  }>(
    `SELECT azure_project_id, azure_project_name, azure_organization_url, provider_id
     FROM projects WHERE id = @projectId AND workspace_id = @workspaceId LIMIT 1`,
    { projectId, workspaceId: job.workspaceId },
  );
  if (!project) throw new Error("Project not found in this workspace.");

  const pat = await resolveWorkspaceSyncPat(job.workspaceId);
  if (!pat) throw new Error("No workspace sync credential configured. Set one in Workspace settings.");

  const scope = {
    projectId,
    azureProjectId: project.azure_project_id,
    azureProjectName: project.azure_project_name,
    azureOrganizationUrl: project.azure_organization_url,
  };
  const adapter = createIntegrationProvider({
    providerId: project.provider_id,
    settings: { organizationUrl: scope.azureOrganizationUrl, personalAccessToken: pat },
    projectScope: { azureProjectId: scope.azureProjectId, azureProjectName: scope.azureProjectName },
  });

  const workItemTypes =
    Array.isArray(job.payload.workItemTypes) && job.payload.workItemTypes.length
      ? (job.payload.workItemTypes as string[])
      : DEFAULT_CONTEXT_WORK_ITEM_TYPES;
  const states =
    Array.isArray(job.payload.states) && job.payload.states.length
      ? (job.payload.states as string[])
      : DEFAULT_CONTEXT_STATES;

  await indexAzureWorkItemsAsProjectContext({ scope, actor: "system:worker", adapter, workItemTypes, states, mode: "incremental" });
}

/** Enqueue a context sync for every active project in a workspace (deduped). */
export async function enqueueWorkspaceContextSync(
  workspaceId: string,
  createdByUserId: string | null,
  filters?: { workItemTypes?: string[]; states?: string[] },
): Promise<number> {
  const projects = await sqlAll<{ id: string }>(
    `SELECT id FROM projects WHERE workspace_id = @workspaceId AND status = 'active'`,
    { workspaceId },
  );
  let enqueued = 0;
  for (const project of projects) {
    const id = await enqueueJob({
      jobType: WORKSPACE_CONTEXT_SYNC,
      workspaceId,
      payload: {
        projectId: project.id,
        ...(filters?.workItemTypes?.length ? { workItemTypes: filters.workItemTypes } : {}),
        ...(filters?.states?.length ? { states: filters.states } : {}),
      },
      dedupeKey: `context_sync:${project.id}`,
      createdByUserId,
    });
    if (id) enqueued += 1;
  }
  return enqueued;
}
