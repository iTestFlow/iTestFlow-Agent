import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireExternalLlmEnabled,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { defaultTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import {
  contextReviewRequiredResponseBody,
  ContextReviewRequiredError,
  prepareWorkflowContext,
} from "@/modules/rag/workflow-context-preparation.service";
import { WorkflowContextControlsSchema } from "@/modules/rag/workflow-context-controls";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import { storyAttachmentInputErrorResponse } from "@/app/api/story-attachments/story-attachment-route-helpers";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  attachmentIds: z.array(z.string().trim().min(1)).max(20).optional().default([]),
  options: TestDesignOptionsRequestSchema.optional(),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
}).merge(WorkflowContextControlsSchema);

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and target work item before preparing the prompt." },
      { status: 400 },
    );
  }

  try {
    const options = parsed.data.options ?? defaultTestDesignOptions;
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireExternalLlmEnabled(ctx);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const workspaceSettings = await getWorkspaceSettings(ctx.workspace.id);
    const prepared = await prepareWorkflowContext({
      workflow: "test_case_generation",
      mode: "manual",
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      workspaceId: ctx.workspace.id,
      workspaceProviderId: resolveWorkspaceProviderId(ctx.workspace),
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      attachmentIds: parsed.data.attachmentIds,
      reviewedSourceIds: parsed.data.reviewedSourceIds,
      excludedSourceIds: parsed.data.excludedSourceIds,
      maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      options,
      extraInstructions: parsed.data.extraInstructions,
    });
    const warnings = [
      prepared.projectKnowledgeNotice,
      ...(prepared.storyAttachmentContext?.warnings ?? []),
      ...(prepared.promptDraft.storyAttachmentWarnings ?? []),
    ]
      .filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0);

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      attachmentIds: parsed.data.attachmentIds,
      reviewedSourceIds: prepared.reviewedSourceIds,
      excludedSourceIds: prepared.excludedSourceIds,
      resolvedContextUsed: prepared.contextUsed,
      contextCitations: prepared.contextCitations,
      retrievalTopK: prepared.retrievalTopK,
      options,
      ...prepared.promptDraft,
      warnings: warnings.length ? Array.from(new Set(warnings)) : undefined,
    });
  } catch (error) {
    if (error instanceof ContextReviewRequiredError) {
      return NextResponse.json(contextReviewRequiredResponseBody(error), { status: 409 });
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const attachmentResponse = storyAttachmentInputErrorResponse(error);
    if (attachmentResponse) return attachmentResponse;
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "External LLM test case prompt preparation failed." });
  }
}
