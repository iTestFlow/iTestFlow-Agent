import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { ProjectKnowledgeBaseSchema } from "@/modules/rag/project-knowledge.schema";
import { saveManualProjectKnowledgeBaseFromBatches } from "@/modules/rag/project-knowledge.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional().default("full"),
  partialKnowledgeBases: z.array(ProjectKnowledgeBaseSchema).default([]),
}).refine((data) => data.mode === "incremental" || data.partialKnowledgeBases.length > 0, {
  message: "Validate all batch responses before saving the knowledge base.",
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Validate all batch responses before saving the knowledge base." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const snapshot = await saveManualProjectKnowledgeBaseFromBatches({
      scope: trustedScope,
      actor: ctx.userId,
      partialKnowledgeBases: parsed.data.partialKnowledgeBases,
      mode: parsed.data.mode,
    });
    return NextResponse.json({ knowledgeBase: snapshot.knowledgeBase, snapshot });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "llm", status: 422, fallback: "External LLM knowledge base finalization failed." });
  }
}
