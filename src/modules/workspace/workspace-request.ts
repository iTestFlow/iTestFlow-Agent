import "server-only";

import type { NextResponse } from "next/server";

import { requireSession, SessionError } from "@/modules/auth/session.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { resolveActiveWorkspaceForUser, type WorkspaceRef } from "./workspace.service";
import {
  requireWorkspaceAccess,
  requireWorkspaceRole,
  WorkspaceAccessError,
  type WorkspaceRole,
} from "./workspace-access.service";

export type WorkspaceRequestContext = { userId: string; workspace: WorkspaceRef };

/**
 * Resolves the authenticated user's (primary) workspace and enforces membership
 * or a required role. Throws SessionError / WorkspaceAccessError, which
 * {@link workspaceRequestError} maps to 401 / 403.
 */
export async function resolveWorkspaceRequest(roles?: WorkspaceRole[]): Promise<WorkspaceRequestContext> {
  const session = await requireSession();
  const workspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId);
  if (!workspace) throw new WorkspaceAccessError("No workspace membership found for this user.");
  if (roles && roles.length) {
    await requireWorkspaceRole(session.userId, workspace.id, roles);
  } else {
    await requireWorkspaceAccess(session.userId, workspace.id);
  }
  return { userId: session.userId, workspace };
}

export function workspaceRequestError(error: unknown): NextResponse | null {
  if (error instanceof SessionError) {
    return routeErrorResponse(error, {
      domain: "auth",
      fallback: error.message,
      status: 401,
    });
  }
  if (error instanceof WorkspaceAccessError) {
    return routeErrorResponse(error, {
      domain: "auth",
      fallback: error.message,
      status: 403,
    });
  }
  return null;
}
