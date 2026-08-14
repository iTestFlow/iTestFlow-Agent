import "server-only";

import { writeAuditLogTransactional } from "@/modules/audit/audit.service";
import { nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import type { IntegrationErrorCode } from "../core/integration-error";

type OperationRow = {
  id: string; mapping_id: string; field_name: string; target_json: string | null;
  workspace_id: string; project_id: string; jira_issue_key: string;
};

export type ClaimedJiraSyncOperation = {
  id: string; mappingId: string; field: string; operation: "pull" | "push"; target: unknown;
};

export async function claimNextJiraSyncOperation(workspaceId: string, projectId?: string, operationId?: string): Promise<ClaimedJiraSyncOperation | null> {
  return withTransaction(async (client) => {
    const staleCutoff = new Date(Date.parse(nowIso()) - 5 * 60 * 1000).toISOString();
    await sqlRun(
      `UPDATE jira_sync_operations SET status = 'pending', processing_started_at = NULL,
         run_after = @now, updated_at = @now
       WHERE status = 'processing' AND processing_started_at < @staleCutoff AND attempts < 5
         AND mapping_id IN (SELECT id FROM jira_sync_mappings WHERE workspace_id = @workspaceId)`,
      { workspaceId, staleCutoff, now: nowIso() }, client,
    );
    const terminal = await sqlAll<{ mapping_id: string; field_name: string }>(
      `UPDATE jira_sync_operations o SET status = 'failed', error_code = 'integration_unavailable',
         processing_started_at = NULL, updated_at = @now
       FROM jira_sync_mappings m
       WHERE o.mapping_id = m.id AND m.workspace_id = @workspaceId
         AND o.status = 'processing' AND o.processing_started_at < @staleCutoff AND o.attempts >= 5
       RETURNING o.mapping_id, o.field_name`,
      { workspaceId, staleCutoff, now: nowIso() }, client,
    );
    for (const failed of terminal) {
      await sqlRun(
        `UPDATE jira_sync_field_states SET status = 'error', updated_at = @now
         WHERE mapping_id = @mappingId AND field_name = @field AND status = 'pending'`,
        { mappingId: failed.mapping_id, field: failed.field_name, now: nowIso() }, client,
      );
      await sqlRun(
        `UPDATE jira_sync_mappings SET status = 'error', updated_at = @now WHERE id = @mappingId`,
        { mappingId: failed.mapping_id, now: nowIso() }, client,
      );
    }
    const candidate = await sqlGet<{ id: string; mapping_id: string; field_name: string; operation: "pull" | "push"; target_json: string | null }>(
      `SELECT o.id, o.mapping_id, o.field_name, o.operation, o.target_json
       FROM jira_sync_operations o JOIN jira_sync_mappings m ON m.id = o.mapping_id
       WHERE m.workspace_id = @workspaceId ${projectId ? "AND m.project_id = @projectId" : ""}
         ${operationId ? "AND o.id = @operationId" : ""}
         AND m.status IN ('syncing', 'conflict')
         AND o.status = 'pending' AND o.run_after <= @now
       ORDER BY o.created_at ASC
       FOR UPDATE OF o SKIP LOCKED LIMIT 1`,
      { workspaceId, ...(projectId ? { projectId } : {}), ...(operationId ? { operationId } : {}), now: nowIso() }, client,
    );
    if (!candidate) return null;
    const claimed = await sqlRun(
      `UPDATE jira_sync_operations SET status = 'processing', attempts = attempts + 1,
         processing_started_at = @now, updated_at = @now
       WHERE id = @id AND status = 'pending'`,
      { id: candidate.id, now: nowIso() }, client,
    );
    if (claimed !== 1) return null;
    return {
      id: candidate.id, mappingId: candidate.mapping_id, field: candidate.field_name,
      operation: candidate.operation, target: parseJson(candidate.target_json),
    };
  });
}

const RETRYABLE_CODES = new Set<IntegrationErrorCode>(["integration_rate_limited", "integration_unavailable", "integration_unknown"]);
export async function failJiraSyncOperation(input: { operationId: string; errorCode: IntegrationErrorCode }): Promise<{ retry: boolean; runAfter: string }> {
  return withTransaction(async (client) => {
    const operation = await sqlGet<{ mapping_id: string; attempts: number }>(
      `SELECT mapping_id, attempts FROM jira_sync_operations
       WHERE id = @operationId AND status = 'processing' FOR UPDATE`,
      { operationId: input.operationId }, client,
    );
    if (!operation) throw new Error("The Jira sync operation is not available for failure handling.");
    const retry = RETRYABLE_CODES.has(input.errorCode) && operation.attempts < 5;
    const now = nowIso();
    const runAfter = new Date(Date.parse(now) + Math.min(300, 2 ** Math.max(0, operation.attempts - 1)) * 1000).toISOString();
    await sqlRun(
      `UPDATE jira_sync_operations SET status = @status, error_code = @errorCode,
         run_after = @runAfter, processing_started_at = NULL, updated_at = @now
       WHERE id = @operationId AND status = 'processing'`,
      { operationId: input.operationId, status: retry ? "pending" : "failed", errorCode: input.errorCode, runAfter, now }, client,
    );
    if (retry) return { retry: true, runAfter };
    await sqlRun(
      `UPDATE jira_sync_field_states SET status = 'error', updated_at = @now
       WHERE mapping_id = @mappingId AND field_name = (
         SELECT field_name FROM jira_sync_operations WHERE id = @operationId
       ) AND status = 'pending'`,
      { mappingId: operation.mapping_id, operationId: input.operationId, now }, client,
    );
    await sqlRun(
      `UPDATE jira_sync_mappings SET status = 'error', updated_at = @now WHERE id = @mappingId`,
      { mappingId: operation.mapping_id, now }, client,
    );
    return { retry: false, runAfter };
  });
}

export async function completeJiraSyncOperation(input: { operationId: string; actor: string }) {
  return withTransaction(async (client) => {
    const operation = await sqlGet<OperationRow>(
      `SELECT o.id, o.mapping_id, o.field_name, o.target_json,
              m.workspace_id, m.project_id, m.jira_issue_key
       FROM jira_sync_operations o JOIN jira_sync_mappings m ON m.id = o.mapping_id
       WHERE o.id = @operationId AND o.status = 'processing'
       FOR UPDATE OF o, m`,
      { operationId: input.operationId }, client,
    );
    if (!operation) throw new Error("The Jira sync operation is not available for completion.");
    const now = nowIso();
    await sqlRun(
      `UPDATE jira_sync_field_states SET baseline_json = @targetJson, local_json = @targetJson,
         remote_json = @targetJson, status = 'in_sync', updated_at = @now
       WHERE mapping_id = @mappingId AND field_name = @field AND status = 'pending'`,
      { mappingId: operation.mapping_id, field: operation.field_name, targetJson: operation.target_json, now }, client,
    );
    await sqlRun(
      `UPDATE jira_sync_operations SET status = 'completed', completed_at = @now, updated_at = @now
       WHERE id = @operationId AND status = 'processing'`,
      { operationId: operation.id, now }, client,
    );
    const outstanding = await sqlGet<{ status: "pending" | "conflict" | "error" }>(
      `SELECT status FROM jira_sync_field_states WHERE mapping_id = @mappingId AND status IN ('pending', 'conflict', 'error')
       ORDER BY CASE status WHEN 'error' THEN 0 WHEN 'conflict' THEN 1 ELSE 2 END LIMIT 1`,
      { mappingId: operation.mapping_id }, client,
    );
    const mappingStatus = outstanding?.status === "error" ? "error" : outstanding?.status === "conflict" ? "conflict" : outstanding ? "syncing" : "active";
    await sqlRun(
      `UPDATE jira_sync_mappings SET status = @status,
         last_synced_at = CASE WHEN @status = 'active' THEN @now ELSE last_synced_at END,
         updated_at = @now WHERE id = @mappingId`,
      { mappingId: operation.mapping_id, status: mappingStatus, now }, client,
    );
    await writeAuditLogTransactional({
      workspaceId: operation.workspace_id, projectId: operation.project_id,
      entityType: "jira_issue", entityId: operation.jira_issue_key,
      action: "jira.sync.operation_completed", status: "Success", actor: input.actor,
      message: "A queued Jira synchronization operation completed.",
      details: { field: operation.field_name },
    }, client);
    return { mappingStatus };
  });
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && parsed.$itestflow === "absent" ? undefined : parsed;
  } catch { throw new Error("The Jira sync operation payload is invalid."); }
}
