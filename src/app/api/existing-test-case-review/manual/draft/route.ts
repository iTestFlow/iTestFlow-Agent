import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { buildExistingTestCaseReviewPromptDraft } from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and target user story before preparing the prompt." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const linkedTestCases = await adapter.fetchLinkedTestCases({
      projectId: trustedScope.azureProjectId,
      userStoryId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContextWithoutLLM({
      scope: trustedScope,
      adapter,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await getRetrievalTopK(ctx.workspace.id),
    });
    const knowledgeContext = await loadProjectKnowledgeContext({ scope: trustedScope, consumer: "existing_test_case_review_manual" });
    const draft = buildExistingTestCaseReviewPromptDraft({
      scope: trustedScope,
      targetRequirement,
      linkedTestCases,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      projectKnowledgeNotice: knowledgeContext.promptNotice,
      extraInstructions: parsed.data.extraInstructions,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: draft.relevantProjectKnowledgeBase,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      linkedTestCases,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      ...draft,
      warnings: knowledgeContext.promptNotice ? [knowledgeContext.promptNotice] : undefined,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "External LLM traceability prompt preparation failed." });
  }
}
