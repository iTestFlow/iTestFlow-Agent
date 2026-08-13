import "server-only";
import { createId, nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

type Backend = { reconcileExecution(input: { projectId: string; testCaseKey: string; testCycleKey: string; statusName: string; stepResults?: Array<{ statusName: string; actualResult?: string }> }): Promise<string> };
export async function publishZephyrExecution(input: {
  workspaceId: string; projectId: string; actorUserId: string; localExecutionId: string; backend: Backend;
  testCaseKey: string; testCycleKey: string; statusName: string; stepResults?: Array<{ statusName: string; actualResult?: string }>;
}): Promise<{ remoteId: string; created: boolean }> {
  const params = { workspaceId: input.workspaceId, projectId: input.projectId, localType: "test_execution", localId: required(input.localExecutionId) };
  const authorized = await sqlGet<{ provider_project_key: string }>(
    `SELECT p.provider_project_key FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @actorUserId AND wm.status = 'active'
     JOIN jira_artifact_backend_configs c ON c.workspace_id = p.workspace_id AND c.project_id = p.id AND c.backend_type = 'zephyr_scale' AND c.status = 'active'
     WHERE p.workspace_id = @workspaceId AND p.id = @projectId AND p.provider_id = 'jira-cloud' AND p.status = 'active'`,
    { ...params, actorUserId: input.actorUserId },
  );
  if (!authorized?.provider_project_key) throw new Error("Zephyr execution publishing is not authorized for this Jira project.");
  const existing = await sqlGet<{ remote_artifact_id: string }>(
    `SELECT remote_artifact_id FROM jira_artifact_links WHERE workspace_id = @workspaceId AND project_id = @projectId
       AND backend_type = 'zephyr_scale' AND local_artifact_type = @localType AND local_artifact_id = @localId AND status = 'active'`, params,
  );
  if (existing) return { remoteId: existing.remote_artifact_id, created: false };
  const now = nowIso(), staleCutoff = new Date(Date.parse(now) - 10 * 60 * 1000).toISOString();
  const claim = await sqlGet<{ id: string }>(
    `INSERT INTO jira_artifact_links (id, workspace_id, project_id, backend_type, local_artifact_type, local_artifact_id, remote_artifact_id, remote_url, status, created_at, updated_at)
     SELECT @id, p.workspace_id, p.id, 'zephyr_scale', @localType, @localId, NULL, NULL, 'publishing', @now, @now
     FROM projects p JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = @actorUserId AND wm.status = 'active'
     WHERE p.workspace_id = @workspaceId AND p.id = @projectId AND p.provider_id = 'jira-cloud' AND p.status = 'active'
     ON CONFLICT (workspace_id, project_id, local_artifact_type, local_artifact_id) DO UPDATE SET id = excluded.id, updated_at = excluded.updated_at
       WHERE jira_artifact_links.backend_type = 'zephyr_scale' AND jira_artifact_links.status = 'publishing' AND jira_artifact_links.updated_at < @staleCutoff
     RETURNING id`,
    { ...params, id: createId("jiraartifact"), actorUserId: input.actorUserId, now, staleCutoff },
  );
  if (!claim) throw new Error("This Zephyr execution is already being published.");
  const remoteId = await input.backend.reconcileExecution({ projectId: authorized.provider_project_key, testCaseKey: input.testCaseKey, testCycleKey: input.testCycleKey, statusName: input.statusName, stepResults: input.stepResults });
  const linked = await sqlGet<{ remote_artifact_id: string }>(
    `UPDATE jira_artifact_links SET remote_artifact_id = @remoteId, remote_url = '', status = 'active', updated_at = @now
     WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId AND status = 'publishing' RETURNING remote_artifact_id`,
    { ...params, id: claim.id, remoteId, now },
  );
  if (!linked) throw new Error("The Zephyr execution claim is no longer owned by this publisher.");
  return { remoteId: linked.remote_artifact_id, created: true };
}
function required(value: string) { if (!value.trim()) throw new Error("Zephyr local execution ID is required."); return value; }
