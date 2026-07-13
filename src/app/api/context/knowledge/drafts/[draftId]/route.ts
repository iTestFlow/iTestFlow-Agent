import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { abandonProjectKnowledgeDraft, getProjectKnowledgeDraft } from "@/modules/rag/project-knowledge-draft.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({ scope: ProjectScopeSchema });
const PatchRequestSchema = z.object({
  scope: ProjectScopeSchema,
  action: z.literal("abandon"),
});
type RouteParams = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    const draft = await getProjectKnowledgeDraft({ scope, draftId });
    return draft
      ? NextResponse.json({ draft })
      : NextResponse.json({ error: "The project knowledge draft was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge draft could not be loaded." });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = PatchRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid draft action is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can abandon knowledge drafts.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    return NextResponse.json({
      draft: await abandonProjectKnowledgeDraft({ scope, draftId, actor: ctx.userId }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The project knowledge draft could not be abandoned." });
  }
}
