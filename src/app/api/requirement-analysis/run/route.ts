import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { runRequirementAnalysis } from "@/modules/requirement-analysis/application/requirement-analysis.service";
import {
  requirementToRetrievalQuery,
  retrieveStoredProjectContext,
  workItemToLlmContextSource,
} from "@/modules/rag/project-context-store.service";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedContextIds: z.array(z.string()).default([]),
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
    const selectedContext = parsed.data.selectedContextIds.length
      ? await loadSelectedContext({
          scope: parsed.data.scope,
          selectedContextIds: parsed.data.selectedContextIds,
          adapter,
        })
      : retrieveStoredProjectContext({
          scope: parsed.data.scope,
          query: requirementToRetrievalQuery(targetRequirement),
          topK: 8,
        });
    const result = await runRequirementAnalysis({
      scope: parsed.data.scope,
      provider,
      targetRequirement,
      selectedContext,
      projectKnowledgeBase: getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      selectedContextIds: parsed.data.selectedContextIds,
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

async function loadSelectedContext(input: {
  scope: z.infer<typeof ProjectScopeSchema>;
  selectedContextIds: string[];
  adapter: ReturnType<typeof getConfiguredAzureDevOpsAdapter>;
}) {
  const stored = retrieveStoredProjectContext({
    scope: input.scope,
    query: input.selectedContextIds.join(" "),
    workItemIds: input.selectedContextIds,
    topK: Math.max(8, input.selectedContextIds.length * 3),
  });
  const foundIds = new Set(stored.map((item) => item.workItemId));
  const missingIds = input.selectedContextIds.filter((id) => !foundIds.has(id));
  if (!missingIds.length) return stored;

  const fetched = await Promise.all(
    missingIds.map((workItemId) =>
      input.adapter.fetchWorkItemById({ projectId: input.scope.azureProjectId, workItemId }),
    ),
  );
  return [...stored, ...fetched.map((item) => workItemToLlmContextSource(item))];
}
