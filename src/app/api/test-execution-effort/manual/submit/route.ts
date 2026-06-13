import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
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
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

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

  let analyticsRunId: string | undefined;
  try {
    analyticsRunId = startWorkflowRun({
      scope: parsed.data.scope,
      workflowType: "test_execution_effort",
      workItemId: parsed.data.storyId,
    });
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.storyId,
    });
    const linkedTestCases = await adapter.fetchLinkedTestCases({
      projectId: parsed.data.scope.azureProjectId,
      userStoryId: parsed.data.storyId,
    });
    const result = completeManualTestExecutionEffort({
      scope: parsed.data.scope,
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
      scope: parsed.data.scope,
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
    const message = error instanceof Error ? error.message : "";
    if (analyticsRunId) {
      failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: message || "Manual Test Execution Effort validation failed." });
    }
    if (message.includes("External LLM output") || message.includes("Paste the external LLM JSON") || message.includes("schema validation")) {
      return NextResponse.json({ error: message }, { status: 422 });
    }
    const safeError = toSafeTestExecutionEffortError(error, "External LLM Test Execution Effort validation failed.", parsed.data.storyId);
    return NextResponse.json({ error: safeError.message }, { status: safeError.status === 400 ? 400 : 422 });
  }
}
