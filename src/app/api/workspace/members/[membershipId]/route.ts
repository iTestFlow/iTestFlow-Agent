import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { getWorkspaceMembership, type WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import {
  MemberActionError,
  removeMember,
  updateMemberRole,
} from "@/modules/workspace/workspace-members.service";

export const runtime = "nodejs";

const RoleSchema = z.object({ role: z.enum(["owner", "admin", "member"]) });

type RouteParams = { params: Promise<{ membershipId: string }> };

/** Resolves the owner/admin caller + their role, or returns the auth error response. */
async function resolveActor() {
  const context = await resolveWorkspaceRequest(["owner", "admin"]);
  const membership = await getWorkspaceMembership(context.userId, context.workspace.id);
  return { context, actorRole: (membership?.role ?? "member") as WorkspaceRole };
}

function memberActionResponse(error: unknown): NextResponse | null {
  if (error instanceof MemberActionError) {
    return routeErrorResponse(error, {
      domain: "settings",
      fallback: error.message,
      status: error.status,
    });
  }
  return workspaceRequestError(error);
}

export async function PATCH(request: Request, { params }: RouteParams) {
  let context;
  let actorRole: WorkspaceRole;
  try {
    ({ context, actorRole } = await resolveActor());
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const parsed = RoleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid role." }, { status: 400 });
  }

  const { membershipId } = await params;
  try {
    await updateMemberRole({
      workspaceId: context.workspace.id,
      membershipId,
      newRole: parsed.data.role,
      actor: { userId: context.userId, role: actorRole },
    });
  } catch (error) {
    const response = memberActionResponse(error);
    if (response) return response;
    throw error;
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: RouteParams) {
  let context;
  let actorRole: WorkspaceRole;
  try {
    ({ context, actorRole } = await resolveActor());
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const { membershipId } = await params;
  try {
    await removeMember({
      workspaceId: context.workspace.id,
      membershipId,
      actor: { userId: context.userId, role: actorRole },
    });
  } catch (error) {
    const response = memberActionResponse(error);
    if (response) return response;
    throw error;
  }

  return NextResponse.json({ ok: true });
}
