import { NextResponse } from "next/server";
import { countTestCategories } from "@/modules/analytics/test-category-normalization";
import { z } from "zod";
import { completeManualTestCaseGeneration } from "@/modules/test-case-design/application/test-case-generation.service";
import {
  authErrorResponse,
  requireExternalLlmEnabled,
  requireWorkflowContext,
  getUserAzureAdapter,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { WorkflowContextCitationsSchema } from "@/modules/rag/workflow-context-citations";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForManualValidationError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders, routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import { AcceptanceCriteriaError, buildAcceptanceCriteriaContract } from "@/modules/test-case-design/acceptance-criteria-contract";
import { verifyManualDraftContract, verifyManualDraftToken } from "@/modules/test-case-design/manual-draft-token";
import { AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  rawOutput: z.string().min(1),
  draftToken: z.string().min(1),
  resolvedContextUsed: z.unknown().optional(),
  contextCitations: WorkflowContextCitationsSchema,
  retrievalTopK: z.number().int().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    const missingResponse = parsed.error.issues.some((issue) => issue.path[0] === "rawOutput");
    return NextResponse.json({ error: missingResponse ? "Paste the external LLM response before continuing." : "A prepared manual prompt and its draft token are required. Prepare a fresh prompt if this draft predates AC validation." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireExternalLlmEnabled(ctx);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const verifiedDraft = verifyManualDraftToken(parsed.data.draftToken, {
      userId: ctx.userId,
      workspaceId: ctx.workspace.id,
      projectId: trustedScope.projectId,
      integrationProvider: resolveWorkspaceProviderId(ctx.workspace),
      storyId: parsed.data.targetWorkItemId,
    });
    const story = await adapter.fetchWorkItemById({ projectId: trustedScope.azureProjectId, workItemId: parsed.data.targetWorkItemId });
    let acceptanceCriteriaContract;
    try {
      acceptanceCriteriaContract = buildAcceptanceCriteriaContract(story);
    } catch (error) {
      if (error instanceof AcceptanceCriteriaError && error.code === AppErrorCode.AcceptanceCriteriaInvalidSource) {
        throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftStale, "The story's acceptance criteria changed since this manual prompt was prepared. Prepare a fresh prompt; your pasted response remains available to copy.");
      }
      throw error;
    }
    verifyManualDraftContract(verifiedDraft, acceptanceCriteriaContract);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "test_case_design",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });
    const result = completeManualTestCaseGeneration({
      scope: trustedScope,
      actor: ctx.userId,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
      acceptanceCriteriaContract,
    });
    updateWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      patch: {
        status: "generated",
        generationCompletedAt: new Date().toISOString(),
        itemsGenerated: result.validatedOutput.testCases.length,
        usedKnowledgeContext: parsed.data.contextCitations.length > 0,
        metadata: {
          testDesign: { categories: countTestCategories(result.validatedOutput.testCases) },
          coverage: { score: result.validatedOutput.summary.coverageEstimate, acceptanceCriteria: { requiredCount: result.acceptanceCriteriaCoverage.requiredCount, coveredCount: result.acceptanceCriteriaCoverage.coveredCount, correctionAttempts: 0 } },
          contextUsed: result.validatedOutput.contextUsed,
        },
      },
    });

    return NextResponse.json({
      analyticsRunId,
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: parsed.data.resolvedContextUsed ?? [],
      contextCitations: parsed.data.contextCitations,
      retrievalTopK: parsed.data.retrievalTopK ?? null,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      acceptanceCriteriaContract: result.acceptanceCriteriaContract,
      acceptanceCriteriaCoverage: result.acceptanceCriteriaCoverage,
    });
  } catch (error) {
    if (error instanceof AcceptanceCriteriaError) {
      if (trustedScope && analyticsRunId) failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error.message });
      return NextResponse.json({ error: error.userMessage, code: error.code, details: error.details }, { status: error.status });
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "External test case generation failed." });
    }
    if (isAppError(error)) {
      const status = statusForManualValidationError(error);
      const headers = integrationScopeHeaders(error);
      return NextResponse.json(toErrorResponse(error), headers ? { status, headers } : { status });
    }
    return routeErrorResponse(error, { domain: "llm", status: 422, fallback: "External LLM test case validation failed." });
  }
}
