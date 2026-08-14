import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getExecutionRunDetails } from "@/modules/test-execution/execution-store.service";

const Schema = z.object({ scope: ProjectScopeSchema });

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { runId } = await context.params;
    const run = await getExecutionRunDetails(runId, ctx.workspace.id, scope.projectId);
    return run ? NextResponse.json({ run }, { headers: { "Cache-Control": "no-store" } }) : NextResponse.json({ error: "Execution run not found." }, { status: 404 });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "Execution run could not be loaded." }, { status: 503 });
  }
}
