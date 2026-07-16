import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { finalizeManualProjectKnowledge } from "@/modules/rag/project-knowledge-actions.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional().default("full"),
  draftId: z.string().min(1),
}).passthrough();

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A validated manual draft is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const result = await finalizeManualProjectKnowledge({
      scope,
      actor: ctx.userId,
      draftId: parsed.data.draftId,
      mode: parsed.data.mode,
    });
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Manual project knowledge finalization failed." });
  }
}
