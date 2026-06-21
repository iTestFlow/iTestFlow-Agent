import { NextResponse } from "next/server";
import { countTestCategories } from "@/modules/analytics/test-category-normalization";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { generateTestCases } from "@/modules/test-case-design/application/test-case-generation.service";
import { defaultTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContext } from "@/modules/rag/auto-context-resolver.service";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from "@/modules/llm/extra-instructions";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { noLlmProviderConfiguredError } from "@/modules/shared/errors/app-error";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  options: TestDesignOptionsRequestSchema.optional(),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH, `Extra Instructions must be ${EXTRA_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project before running this action." },
      { status: 400 },
    );
  }

  let analyticsRunId: string | undefined;
  try {
    const options = parsed.data.options ?? defaultTestDesignOptions;
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const provider = getConfiguredProviderFromEnv();
    if (!provider) {
      const error = noLlmProviderConfiguredError();
      return NextResponse.json(toErrorResponse(error), { status: statusForServerError(error) });
    }
    analyticsRunId = startWorkflowRun({
      scope: parsed.data.scope,
      workflowType: "test_case_design",
      workItemId: parsed.data.targetWorkItemId,
    });

    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContext({
      scope: parsed.data.scope,
      adapter,
      provider,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: getEffectiveRuntimeSettings()?.context.retrievalTopK ?? 8,
      workflowType: "test_case_generation",
    });
    const result = await generateTestCases({
      scope: parsed.data.scope,
      provider,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: await getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
      options,
      extraInstructions: parsed.data.extraInstructions,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: autoContext.contextUsed,
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase,
    });
    updateWorkflowRun({
      scope: parsed.data.scope,
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
      resolvedContextUsed: autoContext.contextUsed,
      contextCitations,
      retrievalTopK: autoContext.retrievalTopK,
      options,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
      tokenUsage: provider.getTokenUsage(),
      warnings: result.warnings,
    });
  } catch (error) {
    writeGenerationFailureAudit({ scope: parsed.data.scope, action: "test_case_generation.run", label: "Test case generation failed.", error });
    if (analyticsRunId) {
      failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Test case generation failed." });
    }
    return NextResponse.json(toErrorResponse(error), { status: statusForServerError(error) });
  }
}
