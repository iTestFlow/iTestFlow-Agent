import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { transitionProjectKnowledgeLintIssue } from "@/modules/rag/project-knowledge-compiled.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  action: z.enum(["confirm", "reject", "ignore", "reopen"]),
  note: z.string().trim().max(1000).optional(),
});
type RouteParams = { params: Promise<{ issueId: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid lint review decision is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can review lint reports.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { issueId } = await params;
    return NextResponse.json({
      issues: await transitionProjectKnowledgeLintIssue({ ...parsed.data, scope, actor: ctx.userId, issueId }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The lint report could not be reviewed." });
  }
}
