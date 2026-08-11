import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  archiveEnvironmentProfile,
  EnvironmentProfileNameConflictError,
  EnvironmentProfileSecretLimitError,
  EnvironmentProfileUpdateConflictError,
  getEnvironmentProfile,
  updateEnvironmentProfile,
} from "@/modules/test-execution/environment-profile.service";
import { EnvironmentUpdateSchema } from "@/modules/test-execution/schemas/test-execution.schemas";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ environmentId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const { environmentId } = await params;
    const profile = await getEnvironmentProfile({
      workspaceId: ctx.workspace.id,
      scope,
      environmentProfileId: environmentId,
    });
    return profile
      ? NextResponse.json({ profile })
      : NextResponse.json({ error: "The environment profile was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The environment profile could not be loaded." });
  }
}

const UpdateSchema = z.object({ scope: ProjectScopeSchema }).merge(EnvironmentUpdateSchema);

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = UpdateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The environment update is not valid." },
      { status: 400 },
    );
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { environmentId } = await params;
    const profile = await updateEnvironmentProfile({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      environmentProfileId: environmentId,
      config: parsed.data.config,
      upsertSecrets: parsed.data.upsertSecrets,
      removeSecretNames: parsed.data.removeSecretNames,
    });
    return profile
      ? NextResponse.json({ profile })
      : NextResponse.json({ error: "The environment profile was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof EnvironmentProfileNameConflictError) {
      return NextResponse.json(
        { error: "An environment profile with this name already exists for the project." },
        { status: 409 },
      );
    }
    if (error instanceof EnvironmentProfileSecretLimitError) {
      return NextResponse.json(
        { error: "An environment profile can hold at most 30 credentials." },
        { status: 400 },
      );
    }
    if (error instanceof EnvironmentProfileUpdateConflictError) {
      return NextResponse.json(
        { error: "The environment profile changed while it was being updated. Refresh it and try again." },
        { status: 409 },
      );
    }
    return routeErrorResponse(error, { fallback: "The environment profile could not be updated." });
  }
}

const ArchiveSchema = z.object({ scope: ProjectScopeSchema });

export async function DELETE(request: Request, { params }: RouteParams) {
  const parsed = ArchiveSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { environmentId } = await params;
    const archived = await archiveEnvironmentProfile({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      environmentProfileId: environmentId,
    });
    return archived
      ? NextResponse.json({ archived: true })
      : NextResponse.json({ error: "The environment profile was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The environment profile could not be archived." });
  }
}
