import "server-only";

import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveWorkflowContext, resolveWorkflowContextWithoutLLM } from "@/modules/rag/auto-context-resolver.service";

export async function loadTestExecutionEffortData(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  actor?: string;
  provider?: LLMProvider;
  storyId: string;
  selectedContextIds?: string[];
  retrievalTopK: number;
}) {
  const scope = assertProjectScope(input.scope);
  const targetRequirement = await input.adapter.fetchWorkItemById({
    projectId: scope.azureProjectId,
    workItemId: input.storyId,
  });
  const linkedTestCases = await input.adapter.fetchLinkedTestCases({
    projectId: scope.azureProjectId,
    userStoryId: input.storyId,
  });
  const context = input.provider
    ? await (() => {
      const actor = input.actor;
      if (!actor) throw new Error("Audit actor is required for Test Execution Effort generation.");
      return resolveWorkflowContext({
        scope,
        actor,
        adapter: input.adapter,
        provider: input.provider,
        targetRequirement,
        selectedContextIds: input.selectedContextIds,
        retrievalTopK: input.retrievalTopK,
        workflowType: "test_execution_effort",
      });
    })()
    : await resolveWorkflowContextWithoutLLM({
        scope,
        adapter: input.adapter,
        targetRequirement,
        selectedContextIds: input.selectedContextIds,
        retrievalTopK: input.retrievalTopK,
      });
  const projectKnowledgeBase = await getSavedProjectKnowledgeBase({ scope });

  return {
    targetRequirement,
    linkedTestCases,
    relatedWorkItems: context.relatedWorkItems,
    selectedContext: context.selectedContext,
    resolvedContextUsed: context.contextUsed,
    retrievalTopK: context.retrievalTopK,
    projectKnowledgeBase,
    hasProjectContext: Boolean(context.selectedContext.length || context.relatedWorkItems.length || projectKnowledgeBase),
  };
}

