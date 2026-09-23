import { NextResponse } from "next/server";
import { countTestCategories } from "@/modules/analytics/test-category-normalization";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { buildTestCaseGenerationPromptDraft, generateTestCases } from "@/modules/test-case-design/application/test-case-generation.service";
import { defaultTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import {
  buildPreparedWorkflowContextCitations,
  ContextReviewRequiredError,
  prepareWorkflowContext,
} from "@/modules/rag/workflow-context-preparation.service";
import { WorkflowContextControlsSchema } from "@/modules/rag/workflow-context-controls";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
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
  const parsed = RequestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project before running this action." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  let analyticsRunId: string | undefined;
  try {
    const options = parsed.data.options ?? defaultTestDesignOptions;
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const provider = await getUserLLMProvider(ctx);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "test_case_design",
      workItemId: parsed.data.targetWorkItemId,
      userId: ctx.userId,
    });

    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const prepared = await prepareWorkflowContext({
      workflow: "test_case_generation",
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
      options,
      extraInstructions: parsed.data.extraInstructions,
    });
    const result = await generateTestCases({
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
      options,
      extraInstructions: parsed.data.extraInstructions,
      preparedPromptDraft: prepared.promptDraft as ReturnType<typeof buildTestCaseGenerationPromptDraft>,
    });
    const contextCitations = buildPreparedWorkflowContextCitations(prepared, result);
    updateWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      patch: {
        status: "generated",
        generationCompletedAt: new Date().toISOString(),
        itemsGenerated: result.validatedOutput.testCases.length,
        usedKnowledgeContext: contextCitations.length > 0,
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
      reviewedSourceIds: prepared.reviewedSourceIds,
      excludedSourceIds: prepared.excludedSourceIds,
      resolvedContextUsed: prepared.contextUsed,
      contextCitations,
      retrievalTopK: prepared.retrievalTopK,
      options,
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
      if (trustedScope && analyticsRunId) failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error.message });
      return NextResponse.json({ error: error.message, code: error.code, missingSourceIds: error.missingSourceIds }, { status: 409 });
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const attachmentResponse = storyAttachmentInputErrorResponse(error);
    if (attachmentResponse) return attachmentResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "test_case_generation.run", label: "Test case generation failed.", error });
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Test case generation failed." });
    }
    const status = statusForServerError(error);
    const headers = integrationScopeHeaders(error);
    return NextResponse.json(toErrorResponse(error), headers ? { status, headers } : { status });
  }
}
