import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
  WorkflowAuthError,
} from "@/modules/credentials/scoped-resolution.service";
import { SessionError } from "@/modules/auth/session.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { runRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContext } from "@/modules/rag/auto-context-resolver.service";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { requirementAnalysisChecklistOptions } from "@/modules/requirement-analysis/checklist-options";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

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
  let scope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      const checklistError = parsed.error.issues.find((issue) => issue.path[0] === "enabledChecklistItemIds");
      const extraInstructionsError = parsed.error.issues.find((issue) => issue.path[0] === "extraInstructions");
      return NextResponse.json(
        { error: checklistError?.message ?? extraInstructionsError?.message ?? "Please select an Azure DevOps project before running this action." },
        { status: 400 },
      );
    }
    // Auth + per-user credentials (replaces global runtime settings). The user's
    // own encrypted Azure PAT and LLM key are used; the org comes from the
    // workspace, never the client.
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    scope = trustedScope;
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const provider = await getUserLLMProvider(ctx);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "requirements_analysis",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });

    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContext({
      scope: trustedScope,
      adapter,
      provider,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await getRetrievalTopK(ctx.workspace.id),
      workflowType: "requirement_analysis",
    });
    const result = await runRequirementAnalysis({
      scope: trustedScope,
      provider,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: await getSavedProjectKnowledgeBase({ scope: trustedScope }),
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      extraInstructions: parsed.data.extraInstructions,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase,
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
        usedKnowledgeContext: contextCitations.length > 0,
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
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      enabledChecklistItemIds: result.enabledChecklistItemIds,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      tokenUsage: provider.getTokenUsage(),
      warnings: result.warnings,
    });
  } catch (error) {
    if (error instanceof SessionError) {
      return NextResponse.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof WorkflowAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Requirement analysis failed", error);
    if (scope) writeGenerationFailureAudit({ scope, action: "requirement_analysis.run", label: "Requirement analysis failed.", error });
    if (scope && analyticsRunId) {
      failWorkflowRun({ scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Requirement analysis failed." });
    }
    return NextResponse.json(toErrorResponse(error), { status: statusForServerError(error) });
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
