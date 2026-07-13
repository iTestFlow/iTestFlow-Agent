import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { resolveProjectKnowledgeDraft } from "@/modules/rag/project-knowledge-draft.service";
import { ProjectKnowledgeBaseSchema } from "@/modules/rag/project-knowledge.schema";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  proposedKnowledge: ProjectKnowledgeBaseSchema,
});
type RouteParams = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid reviewed knowledge proposal is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can resolve project knowledge conflicts.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    return NextResponse.json({
      draft: await resolveProjectKnowledgeDraft({
        scope,
        actor: ctx.userId,
        draftId,
        proposedKnowledge: parsed.data.proposedKnowledge,
      }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge resolution failed." });
  }
}
