import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getProjectKnowledgeDraftReviewContext } from "@/modules/rag/project-knowledge-draft.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({ scope: ProjectScopeSchema });
type RouteParams = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(
      ctx,
      ["owner", "admin"],
      "Only workspace owners and admins can review knowledge evidence.",
    );
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    const reviewContext = await getProjectKnowledgeDraftReviewContext({ scope, draftId });
    return reviewContext
      ? NextResponse.json({ reviewContext })
      : NextResponse.json({ error: "The project knowledge draft was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Knowledge review sources could not be loaded." });
  }
}
