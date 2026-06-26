import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import type { SystemDashboardEffectiveScope } from "@/types/system-dashboard";

export function resolveSystemDashboardAccess({
  role,
  requestedUserId,
  currentUserId,
}: {
  role: WorkspaceRole | null | undefined;
  requestedUserId?: string | null;
  currentUserId: string;
}) {
  const canViewWorkspaceUsers = role === "owner" || role === "admin";
  const normalizedRequestedUserId = requestedUserId?.trim() || null;

  return {
    permissions: { canViewWorkspaceUsers },
    userId: canViewWorkspaceUsers ? normalizedRequestedUserId : currentUserId,
  };
}

export function buildSystemDashboardEffectiveScope({
  userId,
  currentUserId,
  userLabel,
}: {
  userId: string | null;
  currentUserId: string;
  userLabel?: string | null;
}): SystemDashboardEffectiveScope {
  if (!userId) {
    return { mode: "team", label: "All users", userId: null };
  }
  if (userId === currentUserId) {
    return { mode: "mine", label: "My activity", userId };
  }
  return { mode: "user", label: userLabel?.trim() || userId, userId };
}
