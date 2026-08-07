import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { cancelTestExecutionJob } from "@/modules/jobs/test-execution-jobs.service";
import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ runId: string }> };

const RequestSchema = z.object({ scope: ProjectScopeSchema });

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { runId } = await params;

    const run = await sqlGet<{ id: string; status: string; job_id: string | null }>(
      `SELECT id, status, job_id FROM test_execution_runs
       WHERE id = @runId AND workspace_id = @workspaceId AND project_id = @projectId AND azure_project_id = @azureProjectId`,
      {
        runId,
        workspaceId: ctx.workspace.id,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
      },
    );
    if (!run) {
      return NextResponse.json({ error: "The test execution run was not found." }, { status: 404 });
    }
    if (run.status !== "queued" && run.status !== "running") {
      return NextResponse.json({ error: "The run has already finished." }, { status: 409 });
    }

    // A queued run may not have a claimed job yet; cancel the job when it
    // exists and finalize a still-queued run row directly (nothing executed).
    if (run.job_id) {
      await cancelTestExecutionJob({ id: run.job_id, workspaceId: ctx.workspace.id, projectId: scope.projectId });
    }
    const now = nowIso();
    await sqlRun(
      `UPDATE test_execution_runs
       SET status = 'canceled', outcome = 'canceled', finished_at = @now, updated_at = @now
       WHERE id = @runId AND status = 'queued'`,
      { runId, now },
    );
    await sqlRun(
      `UPDATE test_execution_case_runs
       SET status = 'completed', outcome = 'not_run', finished_at = @now, updated_at = @now
       WHERE run_id = @runId AND status = 'pending'
         AND EXISTS (SELECT 1 FROM test_execution_runs r WHERE r.id = @runId AND r.status = 'canceled')`,
      { runId, now },
    );
    await sqlRun(
      `UPDATE test_execution_step_runs
       SET status = 'completed', outcome = 'not_run', finished_at = @now, updated_at = @now
       WHERE run_id = @runId AND status = 'pending'
         AND EXISTS (SELECT 1 FROM test_execution_runs r WHERE r.id = @runId AND r.status = 'canceled')`,
      { runId, now },
    );
    return NextResponse.json({ cancellationRequested: true });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The test execution run could not be canceled." });
  }
}
