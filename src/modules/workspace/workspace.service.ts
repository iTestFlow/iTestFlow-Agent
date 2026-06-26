import "server-only";

import { nowIso, sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { getWorkspaceMembership, type WorkspaceRole } from "./workspace-access.service";

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

/**
 * Login lookup. Only `active` orgs are sign-in-able: a disabled org
 * (see {@link setWorkspaceStatusByOrgUrl}) returns null, so the login route
 * rejects it exactly like an org that was never enabled.
 */
export async function findWorkspaceByAzureOrgUrl(azureOrgUrl: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<WorkspaceRow>(
    `SELECT id, name, azure_org_name, azure_org_url FROM workspaces WHERE azure_org_url = @url AND status = 'active' LIMIT 1`,
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
     WHERE m.user_id = @userId AND m.status = 'active' AND w.status = 'active'
     ORDER BY m.created_at ASC`,
    { userId },
  );
  return rows.map((row) => ({ ...mapWorkspace(row), role: row.role }));
}

/**
 * The caller's primary workspace — their oldest active membership in an active
 * workspace. Used when the client does not specify an explicit workspaceId.
 */
export async function getPrimaryWorkspaceForUser(userId: string): Promise<WorkspaceRef | null> {
  const row = await sqlGet<WorkspaceRow>(
    `SELECT w.id, w.name, w.azure_org_name, w.azure_org_url
     FROM workspace_members m
     JOIN workspaces w ON w.id = m.workspace_id
     WHERE m.user_id = @userId AND m.status = 'active' AND w.status = 'active'
     ORDER BY m.created_at ASC
     LIMIT 1`,
    { userId },
  );
  return row ? mapWorkspace(row) : null;
}

/**
 * The workspace a request should operate in by default (multi-org). Prefers the
 * org the user selected at login (`activeWorkspaceId`), but ALWAYS re-checks
 * membership server-side — the id was trusted at login, yet membership can be
 * revoked or the workspace deactivated mid-session, so it is never trusted on its
 * own. Falls back to the user's primary (oldest) active membership, which is the
 * pre-multi-org behavior. Carries the caller's role so role-gated call sites need
 * no second lookup.
 */
export async function resolveActiveWorkspaceForUser(
  userId: string,
  activeWorkspaceId?: string | null,
): Promise<(WorkspaceRef & { role: WorkspaceRole }) | null> {
  if (activeWorkspaceId) {
    const membership = await getWorkspaceMembership(userId, activeWorkspaceId);
    if (membership) {
      const workspace = await getWorkspaceById(activeWorkspaceId);
      if (workspace) return { ...workspace, role: membership.role };
    }
  }
  return (await getWorkspacesForUser(userId))[0] ?? null;
}

/**
 * Active workspaces, for the pre-auth login org picker. This is the ONLY
 * intentionally unscoped (no membership) workspace read — it exposes just the
 * org display fields (never the internal workspace id) so the login page can
 * list the orgs a deployment enables.
 */
export async function listActiveWorkspaces(): Promise<Array<Omit<WorkspaceRef, "id">>> {
  const rows = await sqlAll<Omit<WorkspaceRow, "id">>(
    `SELECT name, azure_org_name, azure_org_url FROM workspaces WHERE status = 'active' ORDER BY name ASC`,
  );
  return rows.map((row) => ({
    name: row.name,
    azureOrgName: row.azure_org_name,
    azureOrgUrl: row.azure_org_url,
  }));
}

/**
 * Enable/disable an org by its canonical Azure org URL (the `npm run org:enable` /
 * `org:disable` admin path). Disabling is a SOFT delete: `status='inactive'` keeps
 * all projects, knowledge, credentials and members intact (re-enable restores
 * access) while removing the org from the login picker and every workspace
 * resolution path. Returns the affected workspace, or null if no org matched.
 */
export async function setWorkspaceStatusByOrgUrl(
  azureOrgUrl: string,
  status: "active" | "inactive",
): Promise<WorkspaceRef | null> {
  const row = await sqlGet<WorkspaceRow>(
    `UPDATE workspaces SET status = @status, updated_at = @now
     WHERE azure_org_url = @url
     RETURNING id, name, azure_org_name, azure_org_url`,
    { status, url: azureOrgUrl, now: nowIso() },
  );
  return row ? mapWorkspace(row) : null;
}
