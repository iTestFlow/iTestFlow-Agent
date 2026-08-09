import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  deleteEnvironmentSession,
  getEnvironmentProfile,
} from "@/modules/test-execution/environment-profile.service";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ environmentId: string }> };

const InvalidateSchema = z.object({ scope: ProjectScopeSchema });

/** Invalidate the profile's captured login session — the next run logs in fresh. */
export async function DELETE(request: Request, { params }: RouteParams) {
  const parsed = InvalidateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { environmentId } = await params;
    const profile = await getEnvironmentProfile({
      workspaceId: ctx.workspace.id,
      scope,
      environmentProfileId: environmentId,
    });
    if (!profile) {
      return NextResponse.json({ error: "The environment profile was not found." }, { status: 404 });
    }
    const deleted = await deleteEnvironmentSession({
      workspaceId: ctx.workspace.id,
      environmentProfileId: environmentId,
    });
    if (deleted) {
      writeAuditLog({
        workspaceId: ctx.workspace.id,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: scope.azureOrganizationUrl,
        entityType: "test_environment_profile",
        entityId: environmentId,
        action: "test_execution.session_invalidated",
        status: "Success",
        actor: ctx.userId,
        message: `Saved login session for "${profile.name}" was invalidated.`,
      });
    }
    return NextResponse.json({ deleted });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The saved login session could not be invalidated." });
  }
}
