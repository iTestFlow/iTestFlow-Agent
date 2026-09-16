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
import { runRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { rankProjectKnowledgeForWorkItem } from "@/modules/rag/knowledge-relevance.service";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContext } from "@/modules/rag/auto-context-resolver.service";
import { resolveRetrievalTopK } from "@/modules/rag/retrieval-config";
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
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import { storyAttachmentInputErrorResponse } from "@/app/api/story-attachments/story-attachment-route-helpers";
import { loadSelectedStoryAttachmentWorkflowContext } from "@/modules/story-attachments/story-attachment-workflow-context";

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
});

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
    const storyAttachmentContext = await loadSelectedStoryAttachmentWorkflowContext({
      scope: {
        workspaceId: ctx.workspace.id,
        projectId: trustedScope.projectId,
        providerId: resolveWorkspaceProviderId(ctx.workspace),
        canonicalStoryId: stableStoryId(targetRequirement),
        storyDisplayKey: targetRequirement.id.trim() || parsed.data.targetWorkItemId.trim(),
      },
      attachmentIds: parsed.data.attachmentIds,
      includeVisuals: true,
      maxInputTokens: provider.maxInputTokens,
    });
    const autoContext = await resolveWorkflowContext({
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      provider,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await resolveRetrievalTopK({
        workspaceId: ctx.workspace.id,
        query: `${targetRequirement.title}\n${targetRequirement.description ?? ""}`,
      }),
      workflowType: "requirement_analysis",
    });
    const knowledgeContext = await loadProjectKnowledgeContext({ scope: trustedScope, consumer: "requirement_analysis" });
    // Selects the compiled knowledge this work item is actually connected to, by
    // similarity and by the project's own module/provenance/dependency graph.
    const rankedKnowledgeKeys = await rankProjectKnowledgeForWorkItem({
      scope: trustedScope,
      targetRequirement,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      contextWorkItemIds: [
        ...autoContext.relatedWorkItems.map((item) => item.workItemId),
        ...autoContext.selectedContext.map((item) => item.workItemId),
      ],
    });
    const result = await runRequirementAnalysis({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      // Size the prompt's compiled knowledge and related context to the caller's
      // model, keeping the workspace top-K as a floor rather than a ceiling.
      maxInputTokens: storyAttachmentContext.effectivePromptInputTokens ?? provider.maxInputTokens,
      relatedWorkItemsFloor: autoContext.retrievalTopK,
      rankedKnowledgeKeys: rankedKnowledgeKeys ?? undefined,
      projectKnowledgeNotice: knowledgeContext.promptNotice,
      storyAttachments: storyAttachmentContext.promptAttachments,
      attachmentImages: storyAttachmentContext.images,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      extraInstructions: parsed.data.extraInstructions,
    });
    const includedAttachmentTextIds = new Set(result.includedStoryAttachmentTextIds ?? []);
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase,
      storyAttachments: storyAttachmentContext.citationAttachments.filter((attachment) => (
        includedAttachmentTextIds.has(attachment.id.trim()) || attachment.visualCount > 0
      )),
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
      warnings: [
        ...(result.warnings ?? []),
        ...(knowledgeContext.promptNotice ? [knowledgeContext.promptNotice] : []),
        ...storyAttachmentContext.warnings,
      ],
    });
  } catch (error) {
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

function stableStoryId(target: { id: string; raw?: unknown }) {
  const raw = target.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
  }
  return target.id.trim();
}
