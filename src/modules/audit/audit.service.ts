import "server-only";

import { createId, enqueueBackgroundWrite, nowIso, sqlRun } from "@/modules/shared/infrastructure/database/db";

export type AuditStatus = "Success" | "Failed" | "Pending" | "Partial failure" | "Info";

export type AuditLogInput = {
  projectId?: string;
  azureProjectId?: string;
  azureProjectName?: string;
  azureOrganizationUrl?: string;
  entityType?: string;
  entityId?: string;
  action: string;
  status: AuditStatus;
  actor?: string;
  message: string;
  details?: unknown;
};

export function writeAuditLog(input: AuditLogInput) {
  const now = nowIso();
  const params = {
    id: createId("audit"),
    projectId: input.projectId ?? null,
    azureProjectId: input.azureProjectId ?? null,
    azureProjectName: input.azureProjectName ?? null,
    azureOrganizationUrl: input.azureOrganizationUrl ?? null,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    action: input.action,
    status: input.status,
    actor: input.actor ?? "local-user",
    message: input.message,
    detailsJson: input.details ? JSON.stringify(input.details) : null,
    createdAt: now,
    updatedAt: now,
  };

  enqueueBackgroundWrite(`audit:${input.action}`, () =>
    sqlRun(
      `INSERT INTO audit_logs (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        entity_type, entity_id, action, status, actor, message, details_json, created_at, updated_at
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @entityType, @entityId, @action, @status, @actor, @message, @detailsJson, @createdAt, @updatedAt
      )`,
      params,
    ),
  );
}
