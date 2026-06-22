import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { buildRequirementAnalysisPromptDraft } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
  enabledChecklistItemIds: z
    .array(z.enum(requirementAnalysisChecklistItemIdValues))
    .min(1, "Select at least one requirement analysis checklist item.")
    .optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    const checklistError = parsed.error.issues.find((issue) => issue.path[0] === "enabledChecklistItemIds");
    const extraInstructionsError = parsed.error.issues.find((issue) => issue.path[0] === "extraInstructions");
    return NextResponse.json(
      { error: checklistError?.message ?? extraInstructionsError?.message ?? "Please select an Azure DevOps project and target work item before preparing the prompt." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
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
      retrievalTopK: await getRetrievalTopK(ctx.workspace.id),
    });
    const draft = buildRequirementAnalysisPromptDraft({
      scope: parsed.data.scope,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: await getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
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
      ...draft,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM requirement analysis prompt preparation failed." },
      { status: 503 },
    );
  }
}
