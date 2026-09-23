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
import { buildExistingTestCaseReviewPromptDraft, reviewExistingLinkedTestCases } from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import { deriveExistingTestCaseReviewMetrics } from "@/modules/existing-test-case-review/review-metrics";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import {
  buildPreparedWorkflowContextCitations,
  ContextReviewRequiredError,
  prepareWorkflowContext,
} from "@/modules/rag/workflow-context-preparation.service";
import { WorkflowContextControlsSchema } from "@/modules/rag/workflow-context-controls";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
}).merge(WorkflowContextControlsSchema);

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
    const prepared = await prepareWorkflowContext({
      workflow: "existing_test_case_review",
      mode: "auto",
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      provider,
      workspaceId: ctx.workspace.id,
      workspaceProviderId: resolveWorkspaceProviderId(ctx.workspace),
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      reviewedSourceIds: parsed.data.reviewedSourceIds,
      excludedSourceIds: parsed.data.excludedSourceIds,
      maxInputTokens: provider.maxInputTokens,
      extraInstructions: parsed.data.extraInstructions,
    });
    const result = await reviewExistingLinkedTestCases({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      targetRequirement,
      linkedTestCases: prepared.linkedTestCases,
      relatedWorkItems: prepared.relatedWorkItems,
      selectedContext: prepared.selectedContext,
      projectKnowledgeBase: prepared.projectKnowledgeBase,
      maxInputTokens: prepared.maxInputTokens,
      relatedWorkItemsFloor: prepared.retrievalTopK,
      rankedKnowledgeKeys: prepared.rankedKnowledgeKeys,
      projectKnowledgeNotice: prepared.projectKnowledgeNotice,
      extraInstructions: parsed.data.extraInstructions,
      preparedPromptDraft: prepared.promptDraft as ReturnType<typeof buildExistingTestCaseReviewPromptDraft>,
    });
    const contextCitations = buildPreparedWorkflowContextCitations(prepared, result);
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
      linkedTestCases: prepared.linkedTestCases,
      selectedContextIds: parsed.data.selectedContextIds,
      reviewedSourceIds: prepared.reviewedSourceIds,
      excludedSourceIds: prepared.excludedSourceIds,
      resolvedContextUsed: prepared.contextUsed,
      contextCitations,
      retrievalTopK: prepared.retrievalTopK,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      tokenUsage: provider.getTokenUsage(),
      warnings: [...(result.warnings ?? []), ...(prepared.projectKnowledgeNotice ? [prepared.projectKnowledgeNotice] : [])],
    });
  } catch (error) {
    if (error instanceof ContextReviewRequiredError) {
      if (trustedScope && analyticsRunId) failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error.message });
      return NextResponse.json({ error: error.message, code: error.code, missingSourceIds: error.missingSourceIds }, { status: 409 });
    }
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
