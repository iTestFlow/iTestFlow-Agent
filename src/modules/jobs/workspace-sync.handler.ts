import "server-only";

import { sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { resolveWorkspaceSyncPat } from "@/modules/credentials/credential.service";
import { createIntegrationProvider } from "@/modules/integrations/provider-registry";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults";
import { runJiraProjectReconciliation } from "@/modules/integrations/jira-cloud/jira-sync-runtime.service";
import { enqueueJob, type Job } from "./job-queue.service";

export const WORKSPACE_CONTEXT_SYNC = "workspace_context_sync";

/**
 * Scheduled provider-aware context sync for one workspace project. It runs with
 * no logged-in user and resolves only the designated workspace sync principal.
 * Project and site scope always come from the workspace-owned project row.
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

  if (project.provider_id === "jira-cloud") {
    await runJiraProjectReconciliation({
      workspaceId: job.workspaceId, projectId, actor: "system:worker", indexContext: true,
    });
    return;
  }
  if (project.provider_id !== "azure-devops") throw new Error("The project integration provider is unsupported by this worker.");

  const pat = await resolveWorkspaceSyncPat(job.workspaceId);
  if (!pat) throw new Error("No workspace sync credential configured. Set one in Workspace settings.");

  const scope = {
    projectId,
    azureProjectId: project.azure_project_id,
    azureProjectName: project.azure_project_name,
    azureOrganizationUrl: project.azure_organization_url,
  };
  const adapter = createIntegrationProvider({
    providerId: "azure-devops",
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
      maxAttempts: 5,
      createdByUserId,
    });
    if (id) enqueued += 1;
  }
  return enqueued;
}
