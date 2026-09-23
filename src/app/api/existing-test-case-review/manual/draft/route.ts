import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireExternalLlmEnabled,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
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

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
}).merge(WorkflowContextControlsSchema);

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and target user story before preparing the prompt." },
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
    const workspaceSettings = await getWorkspaceSettings(ctx.workspace.id);
    const prepared = await prepareWorkflowContext({
      workflow: "existing_test_case_review",
      mode: "manual",
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      workspaceId: ctx.workspace.id,
      workspaceProviderId: resolveWorkspaceProviderId(ctx.workspace),
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      reviewedSourceIds: parsed.data.reviewedSourceIds,
      excludedSourceIds: parsed.data.excludedSourceIds,
      maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      extraInstructions: parsed.data.extraInstructions,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      linkedTestCases: prepared.linkedTestCases,
      selectedContextIds: parsed.data.selectedContextIds,
      reviewedSourceIds: prepared.reviewedSourceIds,
      excludedSourceIds: prepared.excludedSourceIds,
      resolvedContextUsed: prepared.contextUsed,
      contextCitations: prepared.contextCitations,
      retrievalTopK: prepared.retrievalTopK,
      ...prepared.promptDraft,
      warnings: prepared.projectKnowledgeNotice ? [prepared.projectKnowledgeNotice] : undefined,
    });
  } catch (error) {
    if (error instanceof ContextReviewRequiredError) {
      return NextResponse.json(contextReviewRequiredResponseBody(error), { status: 409 });
    }
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "External LLM traceability prompt preparation failed." });
  }
}
