import { NextResponse } from "next/server";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import {
  cancelProjectKnowledgeJob,
  getProjectKnowledgeJob,
} from "@/modules/jobs/project-knowledge-jobs.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  return readOrCancelJob(request, params, false);
}

export async function DELETE(request: Request, { params }: RouteParams) {
  return readOrCancelJob(request, params, true);
}

async function readOrCancelJob(
  request: Request,
  params: Promise<{ jobId: string }>,
  cancel: boolean,
) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId") ?? "";
  const projectId = url.searchParams.get("projectId") ?? "";
  if (!workspaceId || !projectId) {
    return NextResponse.json({ error: "workspaceId and projectId are required." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(workspaceId);
    if (cancel) {
      await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can cancel project knowledge jobs.");
    }
    const { jobId } = await params;
    const job = cancel
      ? await cancelProjectKnowledgeJob({ id: jobId, workspaceId: ctx.workspace.id, projectId })
      : await getProjectKnowledgeJob({ id: jobId, workspaceId: ctx.workspace.id, projectId });
    return job
      ? NextResponse.json({ job })
      : NextResponse.json({ error: "The project knowledge job was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The project knowledge job could not be loaded." });
  }
}
