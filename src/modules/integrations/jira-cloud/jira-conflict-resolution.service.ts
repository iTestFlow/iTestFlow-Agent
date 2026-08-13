import "server-only";

import { writeAuditLogTransactional } from "@/modules/audit/audit.service";
import { createId, nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";

export async function resolveJiraFieldConflict(input: {
  workspaceId: string; mappingId: string; field: string;
  resolution: "use_local" | "use_remote"; userId: string;
}): Promise<{ resolution: "use_local" | "use_remote"; mappingStatus: "conflict" }> {
  return withTransaction(async (client) => {
    const conflict = await sqlGet<{ mapping_id: string; workspace_id: string; project_id: string; jira_issue_key: string; local_json: string | null; remote_json: string | null }>(
      `SELECT f.mapping_id, f.local_json, f.remote_json, m.workspace_id, m.project_id, m.jira_issue_key
       FROM jira_sync_field_states f
       JOIN jira_sync_mappings m ON m.id = f.mapping_id
       JOIN workspace_members wm ON wm.workspace_id = m.workspace_id AND wm.user_id = @userId AND wm.status = 'active'
       WHERE f.mapping_id = @mappingId AND f.field_name = @field AND f.status = 'conflict'
         AND m.workspace_id = @workspaceId
       FOR UPDATE OF f, m`,
      { workspaceId: input.workspaceId, mappingId: input.mappingId, field: input.field, userId: input.userId }, client,
    );
    if (!conflict) throw new Error("The Jira field conflict is not available in this workspace.");
    const now = nowIso();
    const operation = input.resolution === "use_local" ? "push" : "pull";
    const targetJson = input.resolution === "use_local" ? conflict.local_json : conflict.remote_json;
    await sqlRun(
      `UPDATE jira_sync_field_states SET
         status = 'pending', resolution = @resolution, resolved_by_user_id = @userId,
         resolved_at = @now, updated_at = @now
       WHERE mapping_id = @mappingId AND field_name = @field AND status = 'conflict'`,
      { mappingId: input.mappingId, field: input.field, resolution: input.resolution, userId: input.userId, now }, client,
    );
    await sqlRun(
      `INSERT INTO jira_sync_operations (id, mapping_id, field_name, operation, target_json, status, run_after, created_at, updated_at)
       VALUES (@id, @mappingId, @field, @operation, @targetJson, 'pending', @now, @now, @now)
       ON CONFLICT (mapping_id, field_name) WHERE status IN ('pending', 'processing')
       DO UPDATE SET operation = excluded.operation, target_json = excluded.target_json, status = 'pending', error_code = NULL, updated_at = excluded.updated_at`,
      { id: createId("jiraop"), mappingId: input.mappingId, field: input.field, operation, targetJson, now }, client,
    );
    await sqlRun(
      `UPDATE jira_sync_mappings SET status = 'conflict', updated_at = @now WHERE id = @mappingId AND workspace_id = @workspaceId`,
      { mappingId: input.mappingId, workspaceId: input.workspaceId, now }, client,
    );
    await writeAuditLogTransactional({
      workspaceId: conflict.workspace_id, projectId: conflict.project_id,
      entityType: "jira_issue", entityId: conflict.jira_issue_key,
      action: "jira.sync.conflict_resolved", status: "Success", actor: `user:${input.userId}`,
      message: "A Jira synchronization field conflict was resolved.",
      details: { field: input.field, resolution: input.resolution, queuedOperation: operation },
    }, client);
    return { resolution: input.resolution, mappingStatus: "conflict" };
  });
}
