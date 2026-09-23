import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { buildRequirementAnalysisPromptDraft, runRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import {
  buildPreparedWorkflowContextCitations,
  ContextReviewRequiredError,
  prepareWorkflowContext,
} from "@/modules/rag/workflow-context-preparation.service";
import { WorkflowContextControlsSchema } from "@/modules/rag/workflow-context-controls";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { requirementAnalysisChecklistOptions } from "@/modules/requirement-analysis/checklist-options";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import { storyAttachmentInputErrorResponse } from "@/app/api/story-attachments/story-attachment-route-helpers";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  attachmentIds: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
  enabledChecklistItemIds: z
    .array(z.enum(requirementAnalysisChecklistItemIdValues))
    .min(1, "Select at least one requirement analysis checklist item.")
    .optional(),
}).merge(WorkflowContextControlsSchema);

export async function POST(request: Request) {
  let scope: ProjectScope | undefined;
  let actor: string | undefined;
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
    actor = ctx.userId;
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
    const prepared = await prepareWorkflowContext({
      workflow: "requirement_analysis",
      mode: "auto",
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      provider,
      workspaceId: ctx.workspace.id,
      workspaceProviderId: resolveWorkspaceProviderId(ctx.workspace),
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      attachmentIds: parsed.data.attachmentIds,
      reviewedSourceIds: parsed.data.reviewedSourceIds,
      excludedSourceIds: parsed.data.excludedSourceIds,
      maxInputTokens: provider.maxInputTokens,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      extraInstructions: parsed.data.extraInstructions,
    });
    const result = await runRequirementAnalysis({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      targetRequirement,
      relatedWorkItems: prepared.relatedWorkItems,
      selectedContext: prepared.selectedContext,
      projectKnowledgeBase: prepared.projectKnowledgeBase,
      maxInputTokens: prepared.maxInputTokens,
      relatedWorkItemsFloor: prepared.retrievalTopK,
      rankedKnowledgeKeys: prepared.rankedKnowledgeKeys,
      projectKnowledgeNotice: prepared.projectKnowledgeNotice,
      storyAttachments: prepared.storyAttachmentContext?.promptAttachments,
      attachmentImages: prepared.storyAttachmentContext?.images,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      extraInstructions: parsed.data.extraInstructions,
      preparedPromptDraft: prepared.promptDraft as ReturnType<typeof buildRequirementAnalysisPromptDraft>,
    });
    const contextCitations = buildPreparedWorkflowContextCitations(prepared, result);
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
      reviewedSourceIds: prepared.reviewedSourceIds,
      excludedSourceIds: prepared.excludedSourceIds,
      resolvedContextUsed: prepared.contextUsed,
      contextCitations,
      retrievalTopK: prepared.retrievalTopK,
      enabledChecklistItemIds: result.enabledChecklistItemIds,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      tokenUsage: provider.getTokenUsage(),
      warnings: [
        ...(result.warnings ?? []),
        ...(prepared.projectKnowledgeNotice ? [prepared.projectKnowledgeNotice] : []),
        ...(prepared.storyAttachmentContext?.warnings ?? []),
      ],
    });
  } catch (error) {
    if (error instanceof ContextReviewRequiredError) {
      if (scope && analyticsRunId) failWorkflowRun({ scope, runId: analyticsRunId, error: error.message });
      return NextResponse.json({ error: error.message, code: error.code, missingSourceIds: error.missingSourceIds }, { status: 409 });
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const attachmentResponse = storyAttachmentInputErrorResponse(error);
    if (attachmentResponse) return attachmentResponse;
    console.error("Requirement analysis failed", error);
    if (scope && actor) writeGenerationFailureAudit({ scope, actor, action: "requirement_analysis.run", label: "Requirement analysis failed.", error });
    if (scope && analyticsRunId) {
      failWorkflowRun({ scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Requirement analysis failed." });
    }
    const status = statusForServerError(error);
    const headers = integrationScopeHeaders(error);
    return NextResponse.json(toErrorResponse(error), headers ? { status, headers } : { status });
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
