import { NextResponse } from "next/server";

import { getOptionalSession } from "@/modules/auth/session.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";

export const runtime = "nodejs";

/**
 * Returns the current authenticated session (or null). When a workspaceId query
 * param is provided, also resolves the caller's membership/role in it. Used by
 * the client to know who is signed in; never returns secrets.
 */
export async function GET(request: Request) {
  const session = await getOptionalSession();
  if (!session) {
    return NextResponse.json({ authenticated: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  const membership = workspaceId ? await getWorkspaceMembership(session.userId, workspaceId) : null;

  return NextResponse.json(
    {
      authenticated: true,
      userId: session.userId,
      membership: membership ? { workspaceId: membership.workspaceId, role: membership.role } : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
