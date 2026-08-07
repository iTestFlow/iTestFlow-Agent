import { NextResponse } from "next/server";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { assembleRunDetail } from "@/modules/test-execution/report-assembler";
import { loadRunDetailRows } from "@/modules/test-execution/run.service";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const parsedScope = ProjectScopeSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsedScope.success) {
    return NextResponse.json({ error: "Select an Azure DevOps project first." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsedScope.data.workspaceId);
    const scope = await resolveProjectScope(ctx, parsedScope.data);
    const { runId } = await params;
    const rows = await loadRunDetailRows({ workspaceId: ctx.workspace.id, scope, runId });
    const detail = rows ? assembleRunDetail(rows) : null;
    return detail
      ? NextResponse.json(detail)
      : NextResponse.json({ error: "The test execution run was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The test execution run could not be loaded." });
  }
}
