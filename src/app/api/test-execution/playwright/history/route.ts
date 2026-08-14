import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { listExecutionRuns } from "@/modules/test-execution/execution-store.service";

const Schema = z.object({ scope: ProjectScopeSchema, limit: z.number().int().min(1).max(100).optional() });

export async function POST(request: Request) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({ runs: await listExecutionRuns(ctx.workspace.id, scope.projectId, parsed.data.limit) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "Execution history could not be loaded." }, { status: 503 });
  }
}
