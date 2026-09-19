import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireExternalLlmEnabled,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { buildRequirementAnalysisPromptDraft } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { resolveRetrievalTopK } from "@/modules/rag/retrieval-config";
import { rankProjectKnowledgeForWorkItem } from "@/modules/rag/knowledge-relevance.service";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
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
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    const checklistError = parsed.error.issues.find((issue) => issue.path[0] === "enabledChecklistItemIds");
    const extraInstructionsError = parsed.error.issues.find((issue) => issue.path[0] === "extraInstructions");
    return NextResponse.json(
      { error: checklistError?.message ?? extraInstructionsError?.message ?? "Please select an Azure DevOps project and target work item before preparing the prompt." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireExternalLlmEnabled(ctx);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const attachmentContext = await loadSelectedStoryAttachmentWorkflowContext({
      scope: {
        workspaceId: ctx.workspace.id,
        projectId: trustedScope.projectId,
        providerId: resolveWorkspaceProviderId(ctx.workspace),
        canonicalStoryId: canonicalStoryId(targetRequirement),
        storyDisplayKey: targetRequirement.id.trim() || parsed.data.targetWorkItemId.trim(),
      },
      attachmentIds: parsed.data.attachmentIds,
      includeVisuals: false,
    });
    const autoContext = await resolveWorkflowContextWithoutLLM({
      scope: trustedScope,
      adapter,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await resolveRetrievalTopK({
        workspaceId: ctx.workspace.id,
        query: `${targetRequirement.title}\n${targetRequirement.description ?? ""}`,
      }),
    });
    const knowledgeContext = await loadProjectKnowledgeContext({ scope: trustedScope, consumer: "requirement_analysis_manual" });
    // The prepared prompt must match what the internal run sends for the same work item.
    // Without a model window it fell back to a fixed default regardless of the workspace's
    // configured model-input-limit, and without ranked keys it used keyword-only knowledge
    // selection — so a user copying this prompt out got materially less context than
    // production, silently. There is no LLM provider here, so the window comes from the
    // workspace override: the admin's own statement of what their models accept.
    const workspaceSettings = await getWorkspaceSettings(ctx.workspace.id);
    // Same selection the internal run performs. Without it the prepared prompt differed
    // in *which* knowledge entries it carried, not merely their order — a silent
    // divergence for the same work item.
    const rankedKnowledgeKeys = await rankProjectKnowledgeForWorkItem({
      scope: trustedScope,
      targetRequirement,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      contextWorkItemIds: [
        ...autoContext.relatedWorkItems.map((item) => item.workItemId),
        ...autoContext.selectedContext.map((item) => item.workItemId),
      ],
    });
    const draft = buildRequirementAnalysisPromptDraft({
      rankedKnowledgeKeys: rankedKnowledgeKeys ?? undefined,
      maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      relatedWorkItemsFloor: autoContext.retrievalTopK,
      scope: trustedScope,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      projectKnowledgeNotice: knowledgeContext.promptNotice,
      storyAttachments: attachmentContext.promptAttachments,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      extraInstructions: parsed.data.extraInstructions,
    });
    const includedAttachmentTextIds = new Set(draft.includedStoryAttachmentTextIds ?? []);
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: draft.relevantProjectKnowledgeBase,
      storyAttachments: attachmentContext.citationAttachments.filter((attachment) => includedAttachmentTextIds.has(attachment.id.trim())),
    });
    const warnings = [knowledgeContext.promptNotice, ...attachmentContext.warnings, ...(draft.storyAttachmentWarnings ?? [])]
      .filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0);

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      attachmentIds: parsed.data.attachmentIds,
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      ...draft,
      warnings: warnings.length ? Array.from(new Set(warnings)) : undefined,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const attachmentResponse = storyAttachmentInputErrorResponse(error);
    if (attachmentResponse) return attachmentResponse;
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "External LLM requirement analysis prompt preparation failed." });
  }
}

function canonicalStoryId(targetRequirement: { id: string; raw?: unknown }) {
  const raw = targetRequirement.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const rawId = (raw as Record<string, unknown>).id;
    if (typeof rawId === "string" && rawId.trim()) return rawId.trim();
    if (typeof rawId === "number" && Number.isFinite(rawId)) return String(rawId);
  }
  return targetRequirement.id.trim();
}
