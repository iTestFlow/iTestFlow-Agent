import { NextResponse } from "next/server";
import { countTestCategories } from "@/modules/analytics/test-category-normalization";
import { z } from "zod";
import { completeManualTestCaseGeneration } from "@/modules/test-case-design/application/test-case-generation.service";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { WorkflowContextCitationsSchema } from "@/modules/rag/workflow-context-citations";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForManualValidationError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders, routeErrorResponse } from "@/modules/shared/errors/route-error-response";
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
  resolvedContextUsed: z.unknown().optional(),
  contextCitations: WorkflowContextCitationsSchema,
  retrievalTopK: z.number().int().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
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
      workflowType: "test_case_design",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });
    const result = completeManualTestCaseGeneration({
      scope: trustedScope,
      actor: ctx.userId,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
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
          coverage: { score: result.validatedOutput.summary.coverageEstimate },
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
    });
  } catch (error) {
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
