import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { buildExistingTestCaseReviewPromptDraft } from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";

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
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapter(ctx, parsed.data.scope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const linkedTestCases = await adapter.fetchLinkedTestCases({
      projectId: parsed.data.scope.azureProjectId,
      userStoryId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContextWithoutLLM({
      scope: parsed.data.scope,
      adapter,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: getEffectiveRuntimeSettings()?.context.retrievalTopK ?? 8,
    });
    const draft = buildExistingTestCaseReviewPromptDraft({
      scope: parsed.data.scope,
      targetRequirement,
      linkedTestCases,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: await getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
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
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM traceability prompt preparation failed." },
      { status: 503 },
    );
  }
}
