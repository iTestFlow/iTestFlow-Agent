import "server-only";

import { createId, enqueueBackgroundWrite, nowIso, sqlRun } from "@/modules/shared/infrastructure/database/db";

export type AuditStatus = "Success" | "Failed" | "Pending" | "Partial failure" | "Info";

export type AuditLogInput = {
  workspaceId?: string;
  projectId?: string;
  azureProjectId?: string;
  azureProjectName?: string;
  azureOrganizationUrl?: string;
  entityType?: string;
  entityId?: string;
  action: string;
  status: AuditStatus;
  actor: string;
  message: string;
  details?: unknown;
};

export function writeAuditLog(input: AuditLogInput) {
  const now = nowIso();
  const params = {
    id: createId("audit"),
    // Set explicitly when known (e.g. login, which has no project_id) so the row is
    // visible to workspace-scoped reads. For project-scoped writes that omit it, the
    // set_workspace_id_from_project trigger derives it from project_id (INV-3).
    workspaceId: input.workspaceId ?? null,
    projectId: input.projectId ?? null,
    azureProjectId: input.azureProjectId ?? null,
    azureProjectName: input.azureProjectName ?? null,
    azureOrganizationUrl: input.azureOrganizationUrl ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    action: input.action,
    status: input.status,
    actor: input.actor,
    message: input.message,
    detailsJson: input.details ? JSON.stringify(input.details) : null,
    createdAt: now,
    updatedAt: now,
  };

  enqueueBackgroundWrite(`audit:${input.action}`, () =>
    sqlRun(
      `INSERT INTO audit_logs (
        id, workspace_id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        entity_type, entity_id, action, status, actor, message, details_json, created_at, updated_at
      ) VALUES (
        @id, @workspaceId, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @entityType, @entityId, @action, @status, @actor, @message, @detailsJson, @createdAt, @updatedAt
      )`,
      params,
    ),
  );
}
