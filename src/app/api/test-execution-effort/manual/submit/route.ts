import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  buildTestExecutionEffortPreview,
  completeManualTestExecutionEffort,
  toSafeTestExecutionEffortError,
} from "@/modules/test-execution-effort/test-execution-effort.service";
import {
  StoryIdSchema,
  TestExecutionEffortOptionsSchema,
} from "@/modules/test-execution-effort/test-execution-effort.schema";
import { WorkflowContextCitationsSchema } from "@/modules/rag/workflow-context-citations";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForManualValidationError, toErrorResponse } from "@/modules/shared/errors/error-response";
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
  rawOutput: z.string().trim().min(1),
  resolvedContextUsed: z.unknown().optional(),
  contextCitations: WorkflowContextCitationsSchema,
  retrievalTopK: z.number().int().optional(),
}).merge(TestExecutionEffortOptionsSchema);

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM response before continuing." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "test_execution_effort",
      workItemId: parsed.data.storyId,
      userId: ctx.userId,
    });
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.storyId,
    });
    const linkedTestCases = await adapter.fetchLinkedTestCases({
      projectId: trustedScope.azureProjectId,
      userStoryId: parsed.data.storyId,
    });
    const result = completeManualTestExecutionEffort({
      scope: trustedScope,
      rawOutput: parsed.data.rawOutput,
      targetWorkItemId: parsed.data.storyId,
      linkedTestCases,
    });
    const preview = buildTestExecutionEffortPreview({
      targetRequirement,
      linkedTestCases,
      hasProjectContext: Boolean(parsed.data.resolvedContextUsed),
    });
    completeWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      valueRealized: false,
      patch: {
        itemsGenerated: 1,
        usedKnowledgeContext: parsed.data.contextCitations.length > 0,
        metadata: { contextUsed: parsed.data.resolvedContextUsed ?? [] },
      },
    });

    return NextResponse.json({
      analyticsRunId,
      ...preview,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: parsed.data.resolvedContextUsed ?? [],
      contextCitations: parsed.data.contextCitations,
      retrievalTopK: parsed.data.retrievalTopK ?? null,
      options: TestExecutionEffortOptionsSchema.parse(parsed.data),
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      estimate: result.validatedOutput,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const message = error instanceof Error ? error.message : "";
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: message || "Manual Test Execution Effort validation failed." });
    }
    if (isAppError(error)) {
      return NextResponse.json(toErrorResponse(error), { status: statusForManualValidationError(error) });
    }
    if (message.includes("External LLM output") || message.includes("Paste the external LLM JSON") || message.includes("schema validation")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    const safeError = toSafeTestExecutionEffortError(error, "External LLM Test Execution Effort validation failed.", parsed.data.storyId);
    return NextResponse.json({ error: safeError.message }, { status: safeError.status === 400 ? 400 : 422 });
  }
}
