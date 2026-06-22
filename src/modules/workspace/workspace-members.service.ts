import "server-only";

import { nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import type { WorkspaceRole } from "./workspace-access.service";

/**
 * Workspace membership management (owner/admin only). Lets an owner/admin curate
 * who is in a workspace and at what role. Members self-provision as `member` on
 * first PAT login (see ensureWorkspaceMembership); this is the curation layer on
 * top of that.
 *
 * Every mutation is guarded server-side — the UI mirrors the rules only for
 * affordance, never as the source of truth:
 *  - admins may manage `member`s only; only owners may manage admins/owners or
 *    grant the admin/owner roles;
 *  - the last remaining `owner` can never be demoted or removed (lockout guard).
 */

export type WorkspaceMemberView = {
  membershipId: string;
  userId: string;
  role: WorkspaceRole;
  status: string;
  displayName: string | null;
  email: string | null;
  lastLoginAt: string | null;
  createdAt: string;
};

export type MemberActor = { userId: string; role: WorkspaceRole };

/** Mutation guard failure with an HTTP status the route maps directly. */
export class MemberActionError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MemberActionError";
    this.status = status;
  }
}

type MemberRow = {
  membership_id: string;
  user_id: string;
  role: WorkspaceRole;
  status: string;
  display_name: string | null;
  email: string | null;
  last_login_at: string | null;
  created_at: string;
};

/** Active members of a workspace, owners first, then admins, then members. */
export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
  const rows = await sqlAll<MemberRow>(
    `SELECT m.id AS membership_id, m.user_id, m.role, m.status, m.created_at,
            u.display_name, u.email_or_unique_name AS email, u.last_login_at
     FROM workspace_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.workspace_id = @workspaceId AND m.status = 'active'
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at ASC`,
    { workspaceId },
  );
  return rows.map((row) => ({
    membershipId: row.membership_id,
    userId: row.user_id,
    role: row.role,
    status: row.status,
    displayName: row.display_name,
    email: row.email,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  }));
}

type TargetRow = { user_id: string; role: WorkspaceRole };

/** Loads the target membership scoped to the workspace, or throws 404. */
async function requireTarget(workspaceId: string, membershipId: string): Promise<TargetRow> {
  const row = await sqlGet<TargetRow>(
    `SELECT user_id, role FROM workspace_members
     WHERE id = @membershipId AND workspace_id = @workspaceId AND status = 'active'
     LIMIT 1`,
    { membershipId, workspaceId },
  );
  if (!row) throw new MemberActionError("Member not found in this workspace.", 404);
  return row;
}

/**
 * Privileged-role management is owner-only. A non-owner (admin) may manage `member`s
 * but may not modify/remove another admin or an owner, and may not grant admin/owner.
 */
function assertActorMayManage(actor: MemberActor, targetRole: WorkspaceRole, nextRole?: WorkspaceRole): void {
  if (actor.role === "owner") return;
  const privileged = (role?: WorkspaceRole) => role === "owner" || role === "admin";
  if (privileged(targetRole) || privileged(nextRole)) {
    throw new MemberActionError("Only an owner can manage admins or owners.", 403);
  }
}

export async function updateMemberRole(input: {
  workspaceId: string;
  membershipId: string;
  newRole: WorkspaceRole;
  actor: MemberActor;
}): Promise<void> {
  const target = await requireTarget(input.workspaceId, input.membershipId);
  assertActorMayManage(input.actor, target.role, input.newRole);

  if (target.role === input.newRole) return;

  // Never strand a workspace without an owner. The owner count and the role change
  // happen in ONE statement: the CTE locks every active owner row (FOR UPDATE), so
  // two concurrent demotions of different owners serialize — the second re-reads the
  // post-commit count and is blocked when it would remove the final owner. A 0-row
  // result means the lockout guard fired (the membership was validated above).
  const changed = await sqlRun(
    `WITH active_owners AS (
       SELECT id FROM workspace_members
       WHERE workspace_id = @workspaceId AND role = 'owner' AND status = 'active'
       FOR UPDATE
     )
     UPDATE workspace_members m
        SET role = @newRole, updated_at = @now
      WHERE m.id = @membershipId AND m.workspace_id = @workspaceId
        AND (m.role <> 'owner' OR @newRole = 'owner' OR (SELECT COUNT(*) FROM active_owners) > 1)`,
    { newRole: input.newRole, membershipId: input.membershipId, workspaceId: input.workspaceId, now: nowIso() },
  );
  if (changed === 0) {
    throw new MemberActionError("Cannot demote the last owner of the workspace.", 409);
  }
}

export async function removeMember(input: {
  workspaceId: string;
  membershipId: string;
  actor: MemberActor;
}): Promise<void> {
  const target = await requireTarget(input.workspaceId, input.membershipId);
  assertActorMayManage(input.actor, target.role);

  // Atomic last-owner guard (see updateMemberRole): lock active owners, then delete
  // only if the target is not an owner or another owner remains.
  const changed = await sqlRun(
    `WITH active_owners AS (
       SELECT id FROM workspace_members
       WHERE workspace_id = @workspaceId AND role = 'owner' AND status = 'active'
       FOR UPDATE
     )
     DELETE FROM workspace_members m
      WHERE m.id = @membershipId AND m.workspace_id = @workspaceId
        AND (m.role <> 'owner' OR (SELECT COUNT(*) FROM active_owners) > 1)`,
    { membershipId: input.membershipId, workspaceId: input.workspaceId },
  );
  if (changed === 0) {
    throw new MemberActionError("Cannot remove the last owner of the workspace.", 409);
  }
}
