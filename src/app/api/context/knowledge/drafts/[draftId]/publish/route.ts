import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { publishReviewedProjectKnowledge } from "@/modules/rag/project-knowledge-actions.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ draftId: string }> };

const RequestSchema = z.object({ scope: ProjectScopeSchema });

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can publish project knowledge.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    return NextResponse.json(await publishReviewedProjectKnowledge({ scope, actor: ctx.userId, draftId }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge could not be published." });
  }
}
