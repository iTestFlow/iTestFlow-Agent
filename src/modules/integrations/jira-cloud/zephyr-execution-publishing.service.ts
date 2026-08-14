import "server-only";
import { createId, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { retireStaleJiraArtifactClaims, withJiraArtifactProjectLock } from "./jira-artifact-project-lock";

type Backend = { reconcileExecution(input: { projectId: string; testCaseKey: string; testCycleKey: string; statusName: string; stepResults?: Array<{ statusName: string; actualResult?: string }> }): Promise<string> };
export async function publishZephyrExecution(input: {
  workspaceId: string; projectId: string; actorUserId: string; localExecutionId: string; resolveBackend: () => Promise<Backend>;
  testCaseKey: string; testCycleKey: string; statusName: string; stepResults?: Array<{ statusName: string; actualResult?: string }>;
}): Promise<{ remoteId: string; created: boolean }> {
  const params = { workspaceId: input.workspaceId, projectId: input.projectId, localType: "test_execution", localId: required(input.localExecutionId) };
  const claimed = await withJiraArtifactProjectLock(params, async (lock) => {
    const { client, now } = lock;
    const authorized = await sqlGet<{ provider_project_key: string }>(
      `SELECT p.provider_project_key FROM projects p
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @actorUserId AND wm.status = 'active'
       JOIN jira_artifact_backend_configs c ON c.workspace_id = p.workspace_id AND c.project_id = p.id AND c.backend_type = 'zephyr_scale' AND c.status = 'active'
       WHERE p.workspace_id = @workspaceId AND p.id = @projectId AND p.provider_id = 'jira-cloud' AND p.status = 'active'`,
      { ...params, actorUserId: input.actorUserId },
      client,
    );
    if (!authorized?.provider_project_key) throw new Error("Zephyr execution publishing is not authorized for this Jira project.");
    await retireStaleJiraArtifactClaims(params, lock);
    const existing = await sqlGet<{ remote_artifact_id: string }>(
      `SELECT remote_artifact_id FROM jira_artifact_links WHERE workspace_id = @workspaceId AND project_id = @projectId
         AND backend_type = 'zephyr_scale' AND local_artifact_type = @localType AND local_artifact_id = @localId AND status = 'active'`,
      params,
      client,
    );
    if (existing) return { kind: "existing", existing } as const;
    const backend = await input.resolveBackend();
    const claim = await sqlGet<{ id: string }>(
      `INSERT INTO jira_artifact_links (id, workspace_id, project_id, backend_type, local_artifact_type, local_artifact_id, remote_artifact_id, remote_url, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @projectId, 'zephyr_scale', @localType, @localId, NULL, NULL, 'publishing', @now, @now)
       ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id) DO UPDATE SET
         id = excluded.id, backend_type = excluded.backend_type, remote_artifact_id = NULL, remote_url = NULL,
         status = 'publishing', created_at = excluded.created_at, updated_at = excluded.updated_at
       WHERE jira_artifact_links.status IN ('error', 'missing_remote')
       RETURNING id`,
      { ...params, id: createId("jiraartifact"), now },
      client,
    );
    if (!claim) throw new Error("This Zephyr execution is already being published.");
    return { kind: "claimed", claim, authorized, backend } as const;
  });
  if (claimed.kind === "existing") return { remoteId: claimed.existing.remote_artifact_id, created: false };
  let remoteId: string;
  try {
    remoteId = await claimed.backend.reconcileExecution({ projectId: claimed.authorized.provider_project_key, testCaseKey: input.testCaseKey, testCycleKey: input.testCycleKey, statusName: input.statusName, stepResults: input.stepResults });
  } catch (error) {
    await failOwnedExecutionClaim(params, claimed.claim.id);
    throw error;
  }
  const linked = await withJiraArtifactProjectLock(params, async (lock) => {
    await retireStaleJiraArtifactClaims(params, lock);
    return sqlGet<{ remote_artifact_id: string }>(
      `UPDATE jira_artifact_links l SET remote_artifact_id = @remoteId, remote_url = '', status = 'active', updated_at = @now
       WHERE l.id = @id AND l.workspace_id = @workspaceId AND l.project_id = @projectId AND l.status = 'publishing'
         AND EXISTS (
           SELECT 1 FROM jira_artifact_backend_configs c
           WHERE c.workspace_id = l.workspace_id AND c.project_id = l.project_id
             AND c.backend_type = 'zephyr_scale' AND c.status = 'active'
         )
       RETURNING l.remote_artifact_id`,
      { ...params, id: claimed.claim.id, remoteId, now: lock.now },
      lock.client,
    );
  });
  if (!linked) throw new Error("The Zephyr execution claim is no longer owned by this publisher.");
  return { remoteId: linked.remote_artifact_id, created: true };
}
async function failOwnedExecutionClaim(params: { workspaceId: string; projectId: string; localType: string; localId: string }, claimId: string): Promise<void> {
  await withJiraArtifactProjectLock(params, async (lock) => {
    await retireStaleJiraArtifactClaims(params, lock);
    await sqlRun(
      `UPDATE jira_artifact_links SET status = 'error', updated_at = @now
       WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId AND status = 'publishing'`,
      { ...params, id: claimId, now: lock.now },
      lock.client,
    );
  });
}
function required(value: string) { if (!value.trim()) throw new Error("Zephyr local execution ID is required."); return value; }
