import "server-only";

import { sqlGet } from "@/modules/shared/infrastructure/database/db";

/** Workspace lookups used by login and the credentials API. */

export type WorkspaceRef = {
  id: string;
  name: string;
  azureOrgName: string;
  azureOrgUrl: string;
};

export async function findWorkspaceByAzureOrgUrl(azureOrgUrl: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<{ id: string; name: string; azure_org_name: string; azure_org_url: string }>(
    `SELECT id, name, azure_org_name, azure_org_url FROM workspaces WHERE azure_org_url = @url LIMIT 1`,
    { url: azureOrgUrl },
  );
  return row
    ? { id: row.id, name: row.name, azureOrgName: row.azure_org_name, azureOrgUrl: row.azure_org_url }
    : null;
}

/**
 * The caller's primary workspace — their most recently created active membership.
 * A stopgap until the client passes an explicit workspaceId (Phase 3); single-
 * workspace hosting is the common case for the first release.
 */
export async function getPrimaryWorkspaceForUser(userId: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<{ id: string; name: string; azure_org_name: string; azure_org_url: string }>(
    `SELECT w.id, w.name, w.azure_org_name, w.azure_org_url
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = @userId AND m.status = 'active'
     ORDER BY m.created_at ASC
     LIMIT 1`,
    { userId },
  );
  return row
    ? { id: row.id, name: row.name, azureOrgName: row.azure_org_name, azureOrgUrl: row.azure_org_url }
    : null;
}
