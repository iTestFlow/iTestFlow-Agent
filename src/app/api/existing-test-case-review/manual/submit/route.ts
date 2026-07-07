import { NextResponse } from "next/server";
import { countTestCategories } from "@/modules/analytics/test-category-normalization";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { completeManualExistingTestCaseReview } from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import { deriveExistingTestCaseReviewMetrics } from "@/modules/existing-test-case-review/review-metrics";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { WorkflowContextCitationsSchema } from "@/modules/rag/workflow-context-citations";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForManualValidationError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
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
  rawOutput: z.string().min(1),
  resolvedContextUsed: z.unknown().optional(),
  contextCitations: WorkflowContextCitationsSchema,
  retrievalTopK: z.number().int().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM response before continuing." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "test_gap_analysis",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });
    const result = completeManualExistingTestCaseReview({
      scope: trustedScope,
      actor: ctx.userId,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
    });
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const linkedTestCases = await adapter.fetchLinkedTestCases({
      projectId: trustedScope.azureProjectId,
      userStoryId: parsed.data.targetWorkItemId,
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
        usedKnowledgeContext: parsed.data.contextCitations.length > 0,
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
      resolvedContextUsed: parsed.data.resolvedContextUsed ?? [],
      contextCitations: parsed.data.contextCitations,
      retrievalTopK: parsed.data.retrievalTopK ?? null,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "External traceability review failed." });
    }
    if (isAppError(error)) {
      return NextResponse.json(toErrorResponse(error), { status: statusForManualValidationError(error) });
    }
    return routeErrorResponse(error, { domain: "llm", status: 422, fallback: "External LLM traceability review validation failed." });
  }
}
