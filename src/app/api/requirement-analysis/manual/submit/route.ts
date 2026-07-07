import { NextResponse } from "next/server";
import { z } from "zod";
import { completeManualRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import { WorkflowContextCitationsSchema } from "@/modules/rag/workflow-context-citations";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForManualValidationError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { requirementAnalysisChecklistOptions } from "@/modules/requirement-analysis/checklist-options";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  enabledChecklistItemIds: z
    .array(z.enum(requirementAnalysisChecklistItemIdValues))
    .min(1, "Select at least one requirement analysis checklist item."),
  rawOutput: z.string().min(1),
  resolvedContextUsed: z.unknown().optional(),
  contextCitations: WorkflowContextCitationsSchema,
  retrievalTopK: z.number().int().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    const checklistError = parsed.error.issues.find((issue) => issue.path[0] === "enabledChecklistItemIds");
    const rawOutputError = parsed.error.issues.find((issue) => issue.path[0] === "rawOutput");
    return NextResponse.json(
      { error: checklistError?.message ?? rawOutputError?.message ?? "Paste the external LLM response before continuing." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "requirements_analysis",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });
    const result = completeManualRequirementAnalysis({
      scope: trustedScope,
      actor: ctx.userId,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
    });
    updateWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      patch: {
        status: "generated",
        generationCompletedAt: new Date().toISOString(),
        itemsGenerated: result.validatedOutput.findings.length,
        highRiskItemsFound: result.validatedOutput.summary.criticalCount + result.validatedOutput.summary.highCount,
        mediumRiskItemsFound: result.validatedOutput.summary.mediumCount,
        lowRiskItemsFound: result.validatedOutput.summary.lowCount,
        usedKnowledgeContext: parsed.data.contextCitations.length > 0,
        metadata: {
          requirement: {
            testabilityScore: result.validatedOutput.summary.testabilityScore,
            issueCategories: countRequirementCategories(result.validatedOutput.findings),
          },
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
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      warnings: result.warnings,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "External requirement analysis failed." });
    }
    if (isAppError(error)) {
      return NextResponse.json(toErrorResponse(error), { status: statusForManualValidationError(error) });
    }
    return routeErrorResponse(error, { domain: "llm", status: 422, fallback: "External LLM requirement analysis validation failed." });
  }
}

const checklistLabels = new Map(requirementAnalysisChecklistOptions.map((item) => [item.id, item.title]));

function countRequirementCategories(findings: Array<{ checklistItemId: string }>) {
  return findings.reduce<Record<string, number>>((counts, finding) => {
    const label = checklistLabels.get(finding.checklistItemId as never) ?? finding.checklistItemId;
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
}
