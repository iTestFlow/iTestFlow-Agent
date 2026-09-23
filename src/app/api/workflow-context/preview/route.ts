import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireExternalLlmEnabled,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import {
  ContextReviewRequiredError,
  prepareWorkflowContext,
  workflowContextWorkflowValues,
} from "@/modules/rag/workflow-context-preparation.service";
import { WorkflowContextControlsSchema } from "@/modules/rag/workflow-context-controls";
import {
  requirementAnalysisChecklistItemIdValues,
} from "@/modules/requirement-analysis/checklist-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { storyAttachmentInputErrorResponse } from "@/app/api/story-attachments/story-attachment-route-helpers";

export const runtime = "nodejs";

const RequestSchema = z.object({
  workflow: z.enum(workflowContextWorkflowValues),
  mode: z.enum(["auto", "manual"]),
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().trim().min(1),
  selectedContextIds: z.array(z.string().trim().min(1)).optional().default([]),
  attachmentIds: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  enabledChecklistItemIds: z.array(z.enum(requirementAnalysisChecklistItemIdValues)).optional(),
  options: TestDesignOptionsRequestSchema.optional(),
  extraInstructions: z.string().max(
    EXTRA_INSTRUCTIONS_MAX_LENGTH,
    `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`,
  ).optional(),
}).merge(WorkflowContextControlsSchema);

/**
 * Builds the same request-local context inputs used by a workflow without asking a
 * generative model to produce an answer. The response is the membership a client
 * can freeze for its current story session.
 */
export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select a project and work item before reviewing context." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    if (parsed.data.mode === "manual") await requireExternalLlmEnabled(ctx);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, scope);
    const provider = parsed.data.mode === "auto" ? await getUserLLMProvider(ctx) : undefined;
    const workspaceSettings = parsed.data.mode === "manual"
      ? await getWorkspaceSettings(ctx.workspace.id)
      : undefined;
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: scope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const prepared = await prepareWorkflowContext({
      workflow: parsed.data.workflow,
      mode: parsed.data.mode,
      preview: true,
      scope,
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
      maxInputTokens: provider?.maxInputTokens ?? workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      enabledChecklistItemIds: parsed.data.enabledChecklistItemIds,
      options: parsed.data.options,
      extraInstructions: parsed.data.extraInstructions,
    });

    return NextResponse.json({
      contextCitations: prepared.contextCitations,
      reviewedSourceIds: prepared.reviewedSourceIds,
      excludedSourceIds: prepared.excludedSourceIds,
      contextConsistency: prepared.contextConsistency,
    });
  } catch (error) {
    if (error instanceof ContextReviewRequiredError) {
      return NextResponse.json(
        { error: error.message, code: error.code, missingSourceIds: error.missingSourceIds },
        { status: 409 },
      );
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const attachmentResponse = storyAttachmentInputErrorResponse(error);
    if (attachmentResponse) return attachmentResponse;
    return routeErrorResponse(error, {
      domain: "llm",
      status: 503,
      fallback: "Context review preparation failed.",
    });
  }
}
