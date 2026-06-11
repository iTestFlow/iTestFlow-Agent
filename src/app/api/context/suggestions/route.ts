import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { suggestContextStories } from "@/modules/context-selection/context-selection.service";
import { requirementToRetrievalQuery, retrieveStoredProjectContext, type LlmContextSource } from "@/modules/rag/project-context-store.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  query: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before running this action." }, { status: 400 });
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
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
    const storedContext = distinctContextByWorkItem(
      retrieveStoredProjectContext({
        scope: parsed.data.scope,
        query: parsed.data.query?.trim() || requirementToRetrievalQuery(targetRequirement),
        topK: 40,
      }).filter((item) => item.workItemId !== parsed.data.targetWorkItemId),
    ).slice(0, 8);
    if (!storedContext.length) {
      return NextResponse.json({
        targetWorkItemId: parsed.data.targetWorkItemId,
        suggestions: [],
        rawOutput: null,
        provider: provider.name,
        model: provider.model,
      });
    }
    const result = await suggestContextStories({
      scope: parsed.data.scope,
      provider,
      targetRequirement,
      retrievedContext: storedContext,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      suggestions: result.validatedOutput.suggestedItems,
      rawOutput: result.rawOutput,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    writeGenerationFailureAudit({ scope: parsed.data.scope, action: "context_selection.suggest", label: "Context suggestion failed.", error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context suggestion failed." },
      { status: 503 },
    );
  }
}

function distinctContextByWorkItem(items: LlmContextSource[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.workItemId)) return false;
    seen.add(item.workItemId);
    return true;
  });
}
