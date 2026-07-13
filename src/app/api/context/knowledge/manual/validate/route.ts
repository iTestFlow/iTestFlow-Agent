import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import {
  validateProjectKnowledgeManualBatch,
} from "@/modules/rag/project-knowledge.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { statusForManualValidationError } from "@/modules/shared/errors/error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  rawOutput: z.string().min(1),
  draftId: z.string().min(1),
  batchIndex: z.number().int().positive(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM JSON response before continuing." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({
      knowledgeBase: await validateProjectKnowledgeManualBatch({
        scope: trustedScope,
        draftId: parsed.data.draftId,
        batchIndex: parsed.data.batchIndex,
        rawOutput: parsed.data.rawOutput,
      }),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, {
      domain: "llm",
      status: statusForManualValidationError(error),
      fallback: "External LLM knowledge response validation failed.",
    });
  }
}
