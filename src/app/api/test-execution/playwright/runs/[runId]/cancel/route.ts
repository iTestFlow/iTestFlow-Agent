import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { requestExecutionCancellation } from "@/modules/test-execution/execution-store.service";
import { executionRunJobId, finishRun } from "@/modules/test-execution/execution-store.service";
import { requestJobCancellation } from "@/modules/jobs/job-queue.service";

const Schema = z.object({ scope: ProjectScopeSchema });

export async function POST(request: Request, context: { params: Promise<{ runId: string }> }) {
  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Selected project is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { runId } = await context.params;
    const requested = await requestExecutionCancellation(runId, ctx.workspace.id, scope.projectId);
    if (!requested) return NextResponse.json({ error: "Running execution not found." }, { status: 404 });
    const jobId = await executionRunJobId(runId, ctx.workspace.id, scope.projectId);
    if (jobId) {
      const job = await requestJobCancellation({ id: jobId, workspaceId: ctx.workspace.id, projectId: scope.projectId });
      if (job?.status === "cancelled") await finishRun(runId, "cancelled", "Execution was cancelled before it started.");
    }
    return NextResponse.json({ runId, cancelRequested: true });
  } catch (error) {
    return authErrorResponse(error) ?? NextResponse.json({ error: "Execution cancellation could not be requested." }, { status: 503 });
  }
}
