import "server-only";

import { sqlGet } from "@/modules/shared/infrastructure/database/db";

/**
 * Workspace-scoped authorization helpers (ADR-3). A workspace is the data
 * boundary; membership and role are always resolved server-side from
 * workspace_members — never trusted from the client. These are the primitives
 * Phase 3 will call from every workspace API:
 *
 *   const session = await requireSession();
 *   const membership = await requireWorkspaceAccess(session.userId, workspaceId);
 *   await requireWorkspaceRole(session.userId, workspaceId, ["owner", "admin"]);
 */

export type WorkspaceRole = "owner" | "admin" | "member";

export type WorkspaceMembership = {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: string;
};

export class WorkspaceAccessError extends Error {
  constructor(message = "You do not have access to this workspace.") {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

type MembershipRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  status: string;
};

/** Returns the active membership for (user, workspace), or null. */
export async function getWorkspaceMembership(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMembership | null> {
  const row = await sqlGet<MembershipRow>(
    `SELECT id, workspace_id, user_id, role, status
     FROM workspace_members
     WHERE user_id = @userId AND workspace_id = @workspaceId
     LIMIT 1`,
    { userId, workspaceId },
  );
  if (!row || row.status !== "active") return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
  };
}

/** Resolves the active membership or throws {@link WorkspaceAccessError}. */
export async function requireWorkspaceAccess(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMembership> {
  const membership = await getWorkspaceMembership(userId, workspaceId);
  if (!membership) throw new WorkspaceAccessError();
  return membership;
}

/** Requires active membership AND a role in `roles`, else throws. */
export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  roles: WorkspaceRole[],
): Promise<WorkspaceMembership> {
  const membership = await requireWorkspaceAccess(userId, workspaceId);
  if (!roles.includes(membership.role)) {
    throw new WorkspaceAccessError("Your workspace role is not permitted to perform this action.");
  }
  return membership;
}
