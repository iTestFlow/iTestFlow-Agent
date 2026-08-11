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
  createEnvironmentProfile,
  EnvironmentProfileConfigSecretMismatchError,
  EnvironmentProfileNameConflictError,
  listEnvironmentProfiles,
} from "@/modules/test-execution/environment-profile.service";
import { EnvironmentCreateSchema } from "@/modules/test-execution/schemas/test-execution.schemas";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const profiles = await listEnvironmentProfiles({
      workspaceId: ctx.workspace.id,
      scope,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ profiles });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Environment profiles could not be loaded." });
  }
}

const CreateSchema = z.object({ scope: ProjectScopeSchema }).merge(EnvironmentCreateSchema);

export async function POST(request: Request) {
  const parsed = CreateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "The environment profile is not valid." },
      { status: 400 },
    );
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const profile = await createEnvironmentProfile({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      config: parsed.data.config,
      secrets: parsed.data.secrets,
    });
    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof EnvironmentProfileNameConflictError) {
      return NextResponse.json(
        { error: "An environment profile with this name already exists for the project." },
        { status: 409 },
      );
    }
    if (error instanceof EnvironmentProfileConfigSecretMismatchError) {
      return NextResponse.json({ error: error.issue }, { status: 400 });
    }
    return routeErrorResponse(error, { fallback: "The environment profile could not be created." });
  }
}
