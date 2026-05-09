import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { runRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContext } from "@/modules/rag/auto-context-resolver.service";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).optional().default([]),
});

export async function POST(request: Request) {
  try {
    const parsed = RequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "Please select an Azure DevOps project before running this action." }, { status: 400 });
    }

    const adapter = getConfiguredAzureDevOpsAdapter();
    const provider = getConfiguredProviderFromEnv();
    if (!provider) {
      return NextResponse.json(
        { error: "No LLM provider configured. Set DEFAULT_LLM_PROVIDER and the provider API key in .env.local." },
        { status: 503 },
      );
    }

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
      workflowType: "requirement_analysis",
    });
    const result = await runRequirementAnalysis({
      scope: parsed.data.scope,
      provider,
      targetRequirement,
      relatedWorkItems: autoContext.relatedWorkItems,
      selectedContext: autoContext.selectedContext,
      projectKnowledgeBase: getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: autoContext.contextUsed,
      retrievalTopK: autoContext.retrievalTopK,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    console.error("Requirement analysis failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Requirement analysis failed." },
      { status: 503 },
    );
  }
}
