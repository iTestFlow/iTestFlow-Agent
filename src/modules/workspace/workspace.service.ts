import "server-only";

import { sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import type { WorkspaceRole } from "./workspace-access.service";

/** Workspace lookups used by login, the credentials API, and workflow context. */

export type WorkspaceRef = {
  id: string;
  name: string;
  azureOrgName: string;
  azureOrgUrl: string;
};

type WorkspaceRow = { id: string; name: string; azure_org_name: string; azure_org_url: string };

function mapWorkspace(row: WorkspaceRow): WorkspaceRef {
  return { id: row.id, name: row.name, azureOrgName: row.azure_org_name, azureOrgUrl: row.azure_org_url };
}

export async function findWorkspaceByAzureOrgUrl(azureOrgUrl: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<WorkspaceRow>(
    `SELECT id, name, azure_org_name, azure_org_url FROM workspaces WHERE azure_org_url = @url LIMIT 1`,
    { url: azureOrgUrl },
  );
  return row ? mapWorkspace(row) : null;
}

export async function getWorkspaceById(workspaceId: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<WorkspaceRow>(
    `SELECT id, name, azure_org_name, azure_org_url FROM workspaces WHERE id = @id AND status = 'active' LIMIT 1`,
    { id: workspaceId },
  );
  return row ? mapWorkspace(row) : null;
}

/** Active workspaces the user belongs to, oldest membership first, with their role. */
export async function getWorkspacesForUser(userId: string): Promise<Array<WorkspaceRef & { role: WorkspaceRole }>> {
  const rows = await sqlAll<WorkspaceRow & { role: WorkspaceRole }>(
    `SELECT w.id, w.name, w.azure_org_name, w.azure_org_url, m.role
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = @userId AND m.status = 'active'
     ORDER BY m.created_at ASC`,
    { userId },
  );
  return rows.map((row) => ({ ...mapWorkspace(row), role: row.role }));
}

/**
 * The caller's primary workspace — their most recently created active membership.
 * Used when the client does not specify an explicit workspaceId (single-workspace
 * hosting is the common case for the first release).
 */
export async function getPrimaryWorkspaceForUser(userId: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<WorkspaceRow>(
    `SELECT w.id, w.name, w.azure_org_name, w.azure_org_url
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = @userId AND m.status = 'active'
     ORDER BY m.created_at ASC
     LIMIT 1`,
    { userId },
  );
  return row ? mapWorkspace(row) : null;
}
