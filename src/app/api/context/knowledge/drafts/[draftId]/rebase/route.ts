import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  getUserLLMProvider,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { rebaseProjectKnowledgeDraft } from "@/modules/rag/project-knowledge.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({ scope: ProjectScopeSchema });
type RouteParams = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can rebase project knowledge.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);
    const { draftId } = await params;
    return NextResponse.json({
      draft: await rebaseProjectKnowledgeDraft({ scope, actor: ctx.userId, provider, parentDraftId: draftId }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "llm", fallback: "Project knowledge rebase failed." });
  }
}
