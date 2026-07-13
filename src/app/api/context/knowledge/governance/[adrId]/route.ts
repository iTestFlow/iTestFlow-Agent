import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { decideProjectKnowledgeAdr } from "@/modules/rag/project-knowledge-draft.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  decision: z.string().trim().min(1).max(4000),
});
type RouteParams = { params: Promise<{ adrId: string }> };

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A versioned ADR decision is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can record knowledge compiler ADR decisions.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { adrId } = await params;
    return NextResponse.json(await decideProjectKnowledgeAdr({
      scope,
      actor: ctx.userId,
      adrId,
      decision: parsed.data.decision,
    }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The knowledge compiler ADR decision could not be saved." });
  }
}
