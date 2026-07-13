import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserLLMProvider,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  InvalidKnowledgeBaseOutputMessage,
  TruncatedKnowledgeBaseOutputMessage,
  isInvalidKnowledgeBaseOutputError,
  isTruncatedKnowledgeBaseOutputError,
} from "@/modules/rag/knowledge-error-classification";
import { extractAndSaveProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { isAppError } from "@/modules/shared/errors/app-error";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before extracting the knowledge base." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);

    const draft = await extractAndSaveProjectKnowledgeBase({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      mode: parsed.data.mode ?? "incremental",
    });

    return NextResponse.json(
      { draftId: draft.draftId, requiresReview: true, draft },
      {
        status: 202,
        headers: {
          Deprecation: "true",
          Link: '</api/context/knowledge/preview>; rel="successor-version"',
        },
      },
    );
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "rag.extract_project_knowledge_base", label: "Project knowledge extraction failed.", error });
    // Preserve knowledge-specific validation copy before the shared normalizer
    // handles provider and infrastructure failures.
    if (isTruncatedKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: TruncatedKnowledgeBaseOutputMessage }, { status: 422 });
    }

    if (isInvalidKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: InvalidKnowledgeBaseOutputMessage }, { status: 422 });
    }

    if (isAppError(error)) {
      return routeErrorResponse(error, { domain: "llm", fallback: "Project knowledge extraction failed." });
    }

    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "Project knowledge extraction failed." });
  }
}
