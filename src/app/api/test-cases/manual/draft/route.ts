import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { buildTestCaseGenerationPromptDraft } from "@/modules/test-case-design/application/test-case-generation.service";
import { defaultTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  options: TestDesignOptionsRequestSchema.optional(),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and target work item before preparing the prompt." },
      { status: 400 },
    );
  }

  try {
    const options = parsed.data.options ?? defaultTestDesignOptions;
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapter(ctx, parsed.data.scope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContextWithoutLLM({
      scope: parsed.data.scope,
      adapter,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: getRetrievalTopK(),
    });
    const draft = buildTestCaseGenerationPromptDraft({
      scope: parsed.data.scope,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: await getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
      options,
      extraInstructions: parsed.data.extraInstructions,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: draft.relevantProjectKnowledgeBase,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      options,
      ...draft,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM test case prompt preparation failed." },
      { status: 503 },
    );
  }
}
