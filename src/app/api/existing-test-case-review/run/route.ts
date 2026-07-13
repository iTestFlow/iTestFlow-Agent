import { NextResponse } from "next/server";
import { countTestCategories } from "@/modules/analytics/test-category-normalization";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { reviewExistingLinkedTestCases } from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import { deriveExistingTestCaseReviewMetrics } from "@/modules/existing-test-case-review/review-metrics";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContext } from "@/modules/rag/auto-context-resolver.service";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

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
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project before running this action." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const provider = await getUserLLMProvider(ctx);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "test_gap_analysis",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });

    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const linkedTestCases = await adapter.fetchLinkedTestCases({
      projectId: trustedScope.azureProjectId,
      userStoryId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContext({
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      provider,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await getRetrievalTopK(ctx.workspace.id),
      workflowType: "existing_test_case_review",
    });
    const knowledgeContext = await loadProjectKnowledgeContext({ scope: trustedScope, consumer: "existing_test_case_review" });
    const result = await reviewExistingLinkedTestCases({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
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
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase,
    });
    const metrics = deriveExistingTestCaseReviewMetrics(result.validatedOutput);
    updateWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      patch: {
        status: "generated",
        generationCompletedAt: new Date().toISOString(),
        itemsGenerated: result.validatedOutput.suggestedAdditions.length,
        highRiskItemsFound: metrics.highRiskItemsFound,
        mediumRiskItemsFound: metrics.mediumRiskItemsFound,
        lowRiskItemsFound: metrics.lowRiskItemsFound,
        usedKnowledgeContext: contextCitations.length > 0,
        metadata: {
          coverage: {
            score: result.validatedOutput.coverageScore,
            missingAreas: metrics.gapRows.length,
            weakDuplicateCases: metrics.weakDuplicateCases,
          },
          testDesign: { categories: countTestCategories(result.validatedOutput.suggestedAdditions) },
          contextUsed: result.validatedOutput.contextUsed,
        },
      },
    });

    return NextResponse.json({
      analyticsRunId,
      targetWorkItemId: parsed.data.targetWorkItemId,
      linkedTestCases,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      tokenUsage: provider.getTokenUsage(),
      warnings: [...(result.warnings ?? []), ...(knowledgeContext.promptNotice ? [knowledgeContext.promptNotice] : [])],
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "existing_test_case_review.run", label: "Test Coverage Matrix generation failed.", error });
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Test Coverage Matrix failed." });
    }
    const status = statusForServerError(error);
    const headers = integrationScopeHeaders(error);
    return NextResponse.json(toErrorResponse(error), headers ? { status, headers } : { status });
  }
}
