import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { buildTestCaseGenerationPromptDraft } from "@/modules/test-case-design/application/test-case-generation.service";
import { defaultTestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestDesignOptionsRequestSchema } from "@/modules/test-case-design/test-design-options.schema";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
  options: TestDesignOptionsRequestSchema.optional(),
});

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
    const adapter = getConfiguredAzureDevOpsAdapter();
    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const autoContext = await resolveWorkflowContextWithoutLLM({
      scope: parsed.data.scope,
      adapter,
      targetRequirement,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: getEffectiveRuntimeSettings()?.context.retrievalTopK ?? 8,
    });
    const draft = buildTestCaseGenerationPromptDraft({
      scope: parsed.data.scope,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
      options,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: autoContext.contextUsed,
      retrievalTopK: autoContext.retrievalTopK,
      options,
      ...draft,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM test case prompt preparation failed." },
      { status: 503 },
    );
  }
}
