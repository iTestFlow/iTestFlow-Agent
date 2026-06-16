import { NextResponse } from "next/server";
import { z } from "zod";
import { completeManualRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import { WorkflowContextCitationsSchema } from "@/modules/rag/workflow-context-citations";
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

  const analyticsRunId = startWorkflowRun({
    scope: parsed.data.scope,
    workflowType: "requirements_analysis",
    workItemId: parsed.data.targetWorkItemId,
  });
  try {
    const result = completeManualRequirementAnalysis({
      scope: parsed.data.scope,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.targetWorkItemId,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
    });
    updateWorkflowRun({
      scope: parsed.data.scope,
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
    });
  } catch (error) {
    failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "External requirement analysis failed." });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM requirement analysis validation failed." },
      { status: 422 },
    );
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
