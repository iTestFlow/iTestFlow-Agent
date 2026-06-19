import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
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
import { isAppError, noLlmProviderConfiguredError } from "@/modules/shared/errors/app-error";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
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
}).merge(TestExecutionEffortOptionsSchema);

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and enter a valid User Story ID." },
      { status: 400 },
    );
  }

  let analyticsRunId: string | undefined;
  try {
    const provider = getConfiguredProviderFromEnv();
    if (!provider) {
      const error = noLlmProviderConfiguredError();
      return NextResponse.json(toErrorResponse(error), { status: statusForServerError(error) });
    }
    analyticsRunId = startWorkflowRun({
      scope: parsed.data.scope,
      workflowType: "test_execution_effort",
      workItemId: parsed.data.storyId,
    });

    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const options = TestExecutionEffortOptionsSchema.parse(parsed.data);
    const data = await loadTestExecutionEffortData({
      scope: parsed.data.scope,
      adapter,
      provider,
      storyId: parsed.data.storyId,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: getEffectiveRuntimeSettings()?.context.retrievalTopK ?? 8,
    });
    const preview = buildTestExecutionEffortPreview({
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      hasProjectContext: data.hasProjectContext,
    });
    const result = await generateTestExecutionEffort({
      scope: parsed.data.scope,
      provider,
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      relatedWorkItems: data.relatedWorkItems,
      selectedContext: data.selectedContext,
      projectKnowledgeBase: data.projectKnowledgeBase,
      options,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: data.resolvedContextUsed,
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase,
    });
    completeWorkflowRun({
      scope: parsed.data.scope,
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
      warnings: result.warnings,
    });
  } catch (error) {
    writeGenerationFailureAudit({ scope: parsed.data.scope, action: "test_execution_effort.run", label: "Test Execution Effort generation failed.", error });
    if (isAppError(error)) {
      if (analyticsRunId) {
        failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error.message });
      }
      return NextResponse.json(toErrorResponse(error), { status: statusForServerError(error) });
    }
    const safeError = toSafeTestExecutionEffortError(error, "Test Execution Effort generation failed.", parsed.data.storyId);
    if (analyticsRunId) {
      failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: safeError.message });
    }
    return NextResponse.json({ error: safeError.message }, { status: safeError.status });
  }
}

