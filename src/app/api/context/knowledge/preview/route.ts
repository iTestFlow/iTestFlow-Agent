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
import { previewGeneratedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders, routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";
export const maxDuration = 300;

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional(),
});

export async function POST(request: Request) {
  let requestBody: unknown;
  try {
    requestBody = await request.json();
  } catch {
    return NextResponse.json({ error: "The request body must be valid JSON." }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(requestBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before previewing the knowledge base." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);

    const draft = await previewGeneratedProjectKnowledgeBase({
      scope: trustedScope,
      provider,
      mode: parsed.data.mode ?? "incremental",
    });
    return NextResponse.json({
      ...draft,
      tokenUsage: provider.getTokenUsage() ?? (draft.provider === "local" ? { input: 0, output: 0, total: 0 } : undefined),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "rag.preview_project_knowledge_base", label: "Project knowledge preview failed.", error });
    // Unlike the extract route, AppErrors are handled BEFORE the knowledge-output
    // classifiers: a matching AppError gets its own userMessage/status, not the guidance.
    if (isAppError(error)) {
      const status = statusForServerError(error);
      const headers = integrationScopeHeaders(error);
      return NextResponse.json(toErrorResponse(error), headers ? { status, headers } : { status });
    }

    if (isTruncatedKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: TruncatedKnowledgeBaseOutputMessage }, { status: 422 });
    }

    if (isInvalidKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: InvalidKnowledgeBaseOutputMessage }, { status: 422 });
    }

    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "Project knowledge preview failed." });
  }
}
