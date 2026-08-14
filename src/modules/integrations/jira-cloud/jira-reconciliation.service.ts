import "server-only";

import { writeAuditLogTransactional } from "@/modules/audit/audit.service";
import { createId, nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { reconcileJiraFields, type JiraSyncFields } from "./jira-sync-conflict";

type MappingRow = {
  id: string; workspace_id: string; project_id: string; jira_issue_key: string;
  direction: "jira_to_itestflow" | "itestflow_to_jira" | "two_way";
};

export async function reconcileJiraMapping(input: {
  workspaceId: string; mappingId: string; actor: string;
  baseline: JiraSyncFields; local: JiraSyncFields; remote: JiraSyncFields;
}) {
  return withTransaction(async (client) => {
    const mapping = await sqlGet<MappingRow>(
      `SELECT id, workspace_id, project_id, jira_issue_key, direction
       FROM jira_sync_mappings
       WHERE id = @mappingId AND workspace_id = @workspaceId AND status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM jira_sync_operations o
           WHERE o.mapping_id = jira_sync_mappings.id AND o.status IN ('pending', 'processing')
         )
       FOR UPDATE`,
      { mappingId: input.mappingId, workspaceId: input.workspaceId }, client,
    );
    if (!mapping) throw new Error("The Jira sync mapping is not available in this workspace.");
    const result = reconcileForDirection(input, mapping.direction);
    const now = nowIso();
    const conflictFields = new Set(result.conflicts.map((conflict) => conflict.field));
    for (const field of new Set([...Object.keys(result.merged), ...conflictFields])) {
      const conflict = result.conflicts.find((item) => item.field === field);
      const operation = has(result.pulls, field) ? "pull" : has(result.pushes, field) ? "push" : undefined;
      const status = conflict ? "conflict" : operation ? "pending" : "in_sync";
      await sqlRun(
        `INSERT INTO jira_sync_field_states (
           id, mapping_id, field_name, baseline_json, local_json, remote_json, status, resolution, resolved_by_user_id, resolved_at, created_at, updated_at
         ) VALUES (
           @id, @mappingId, @field, @baselineJson, @localJson, @remoteJson, @status, NULL, NULL, NULL, @now, @now
         )
         ON CONFLICT (mapping_id, field_name) DO UPDATE SET
           baseline_json = excluded.baseline_json, local_json = excluded.local_json,
           remote_json = excluded.remote_json, status = excluded.status,
           resolution = NULL, resolved_by_user_id = NULL, resolved_at = NULL, updated_at = excluded.updated_at`,
        {
          id: createId("jirafield"), mappingId: mapping.id, field,
          baselineJson: encode(input.baseline, field),
          localJson: encode(input.local, field), remoteJson: encode(input.remote, field),
          status, now,
        }, client,
      );
      if (operation) {
        const target = operation === "pull" ? result.pulls[field] : result.pushes[field];
        await sqlRun(
          `INSERT INTO jira_sync_operations (id, mapping_id, field_name, operation, target_json, status, run_after, created_at, updated_at)
           VALUES (@id, @mappingId, @field, @operation, @targetJson, 'pending', @now, @now, @now)
           ON CONFLICT (mapping_id, field_name) WHERE status IN ('pending', 'processing')
           DO UPDATE SET operation = excluded.operation, target_json = excluded.target_json, status = 'pending', error_code = NULL, updated_at = excluded.updated_at`,
          { id: createId("jiraop"), mappingId: mapping.id, field, operation, targetJson: encodeValue(target), now }, client,
        );
      }
    }
    const blocked = result.conflicts.length > 0;
    const hasOperations = Object.keys(result.pulls).length > 0 || Object.keys(result.pushes).length > 0;
    const mappingStatus = blocked ? "conflict" : hasOperations ? "syncing" : "active";
    await sqlRun(
      `UPDATE jira_sync_mappings SET status = @status, updated_at = @now WHERE id = @mappingId`,
      { mappingId: mapping.id, status: mappingStatus, now }, client,
    );
    await writeAuditLogTransactional({
      workspaceId: mapping.workspace_id, projectId: mapping.project_id,
      entityType: "jira_issue", entityId: mapping.jira_issue_key,
      action: blocked ? "jira.sync.conflict" : "jira.sync.queued",
      status: "Pending", actor: input.actor,
      message: blocked ? "Jira synchronization is blocked by field conflicts." : "Jira synchronization work was queued.",
      details: { conflictFields: [...conflictFields], pullFields: Object.keys(result.pulls), pushFields: Object.keys(result.pushes) },
    }, client);
    return { ...result, pushes: blocked ? {} : result.pushes, blocked };
  });
}

function reconcileForDirection(input: { baseline: JiraSyncFields; local: JiraSyncFields; remote: JiraSyncFields }, direction: MappingRow["direction"]) {
  if (direction === "two_way") return reconcileJiraFields(input);
  const merged: JiraSyncFields = {};
  const pulls: JiraSyncFields = {};
  const pushes: JiraSyncFields = {};
  for (const field of new Set([...Object.keys(input.baseline), ...Object.keys(input.local), ...Object.keys(input.remote)])) {
    if (direction === "jira_to_itestflow") {
      merged[field] = input.remote[field];
      if (!same(input.local[field], input.remote[field])) pulls[field] = input.remote[field];
    } else {
      merged[field] = input.local[field];
      if (!same(input.remote[field], input.local[field])) pushes[field] = input.local[field];
    }
  }
  return { merged, pulls, pushes, conflicts: [] };
}

const ABSENT = { $itestflow: "absent" };
function has(fields: JiraSyncFields, field: string) { return Object.prototype.hasOwnProperty.call(fields, field); }
function encode(fields: JiraSyncFields, field: string) { return has(fields, field) ? encodeValue(fields[field]) : JSON.stringify(ABSENT); }
function encodeValue(value: unknown) { return value === undefined ? JSON.stringify(ABSENT) : JSON.stringify(value); }
function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
