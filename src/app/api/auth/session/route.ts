import { NextResponse } from "next/server";

import { getOptionalSession } from "@/modules/auth/session.service";
import { getWorkspaceMembership, type WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import { getWorkspaceById, resolveActiveWorkspaceForUser, type WorkspaceRef } from "@/modules/workspace/workspace.service";

export const runtime = "nodejs";

/**
 * Returns the current authenticated session (or null). When a workspaceId query
 * param is provided, resolves the caller's membership/role in it; otherwise it
 * returns the caller's primary workspace membership. Used by the client to know
 * who is signed in; never returns secrets.
 */
export async function GET(request: Request) {
  const session = await getOptionalSession();
  if (!session) {
    return NextResponse.json({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  let membership: { workspaceId: string; role: WorkspaceRole } | null = null;
  let workspace: WorkspaceRef | null = null;
  if (workspaceId) {
    const scopedMembership = await getWorkspaceMembership(session.userId, workspaceId);
    membership = scopedMembership ? { workspaceId: scopedMembership.workspaceId, role: scopedMembership.role } : null;
    workspace = scopedMembership ? await getWorkspaceById(workspaceId) : null;
  } else {
    const activeWorkspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId);
    membership = activeWorkspace ? { workspaceId: activeWorkspace.id, role: activeWorkspace.role } : null;
    workspace = activeWorkspace;
  }

  return NextResponse.json(
    {
      authenticated: true,
      userId: session.userId,
      membership,
      workspace: workspace ? {
        id: workspace.id,
        name: workspace.name,
        providerId: workspace.providerId,
        providerSiteName: workspace.providerSiteName,
        providerSiteUrl: workspace.providerSiteUrl,
      } : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
