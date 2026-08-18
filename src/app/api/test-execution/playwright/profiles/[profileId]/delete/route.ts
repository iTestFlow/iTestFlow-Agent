import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { deleteExecutionProfile } from "@/modules/test-execution/execution-profiles.service";

export const runtime = "nodejs";

const Schema = z.object({ scope: ProjectScopeSchema });

export async function POST(request: Request, context: { params: Promise<{ profileId: string }> }) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { profileId } = await context.params;
    const deleted = await deleteExecutionProfile(profileId, ctx.workspace.id, scope.projectId);
    if (!deleted) return NextResponse.json({ error: "Execution profile not found." }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "The execution profile could not be deleted." }, { status: 503 });
  }
}
