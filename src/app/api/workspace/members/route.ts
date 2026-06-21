import { NextResponse } from "next/server";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";
import { listWorkspaceMembers } from "@/modules/workspace/workspace-members.service";

export const runtime = "nodejs";

/**
 * Lists the workspace's active members and the caller's own role so the UI can
 * decide which controls to show (owner/admin only). Members never see this list.
 */
export async function GET() {
  let context;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const actor = await getWorkspaceMembership(context.userId, context.workspace.id);
  const members = await listWorkspaceMembers(context.workspace.id);
  return NextResponse.json(
    {
      workspaceId: context.workspace.id,
      currentUserId: context.userId,
      currentUserRole: actor?.role ?? null,
      members,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
