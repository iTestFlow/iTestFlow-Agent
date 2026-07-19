import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { loadTestExecutionEffortData } from "@/modules/test-execution-effort/test-execution-effort.data-loader";
import {
  buildTestExecutionEffortPreview,
  generateTestExecutionEffort,
  toSafeTestExecutionEffortError,
} from "@/modules/test-execution-effort/test-execution-effort.service";
import {
  StoryIdSchema,
  TestExecutionEffortOptionsSchema,
} from "@/modules/test-execution-effort/test-execution-effort.schema";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  storyId: StoryIdSchema,
  selectedContextIds: z.array(z.string()).optional().default([]),
}).merge(TestExecutionEffortOptionsSchema);

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and enter a valid User Story ID." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "test_execution_effort",
      workItemId: parsed.data.storyId,
      userId: ctx.userId,
    });

    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const options = TestExecutionEffortOptionsSchema.parse(parsed.data);
    const data = await loadTestExecutionEffortData({
      scope: trustedScope,
      adapter,
      actor: ctx.userId,
      provider,
      storyId: parsed.data.storyId,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await getRetrievalTopK(ctx.workspace.id),
    });
    const preview = buildTestExecutionEffortPreview({
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      hasProjectContext: data.hasProjectContext,
    });
    const result = await generateTestExecutionEffort({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      relatedWorkItems: data.relatedWorkItems,
      selectedContext: data.selectedContext,
      projectKnowledgeBase: data.projectKnowledgeBase,
      projectKnowledgeNotice: data.projectKnowledgeNotice,
      options,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: data.resolvedContextUsed,
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase,
    });
    completeWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      valueRealized: false,
      patch: {
        itemsGenerated: 1,
        usedKnowledgeContext: contextCitations.length > 0,
        metadata: { contextUsed: data.resolvedContextUsed },
      },
    });

    return NextResponse.json({
      analyticsRunId,
      ...preview,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: data.resolvedContextUsed,
      contextCitations,
      retrievalTopK: data.retrievalTopK,
      options,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      tokenUsage: provider.getTokenUsage(),
      estimate: result.validatedOutput,
      warnings: [...(result.warnings ?? []), ...(data.projectKnowledgeNotice ? [data.projectKnowledgeNotice] : [])],
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "test_execution_effort.run", label: "Test Execution Effort generation failed.", error });
    if (isAppError(error)) {
      if (trustedScope && analyticsRunId) {
        failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error.message });
      }
      const status = statusForServerError(error);
      const headers = integrationScopeHeaders(error);
      return NextResponse.json(toErrorResponse(error), headers ? { status, headers } : { status });
    }
    const safeError = toSafeTestExecutionEffortError(error, "Test Execution Effort generation failed.", parsed.data.storyId);
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: safeError.message });
    }
    const status = statusForServerError(error, { status: safeError.status });
    const headers = integrationScopeHeaders(error);
    return NextResponse.json({ error: safeError.message }, headers ? { status, headers } : { status });
  }
}

