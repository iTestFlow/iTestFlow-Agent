import "server-only";

import type { LLMProvider } from "@/modules/llm/llm-types";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { suggestContextStories } from "@/modules/context-selection/context-selection.service";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  requirementToRetrievalQuery,
  retrieveStoredProjectContext,
  workItemToLlmContextSource,
  type LlmContextSource,
} from "./project-context-store.service";

export const REQUIREMENT_CONTEXT_WORK_ITEM_TYPES = [
  "Epic",
  "Feature",
  "User Story",
  "Product Backlog Item",
  "Requirement",
];

const REQUIREMENT_CONTEXT_TYPES = new Set(REQUIREMENT_CONTEXT_WORK_ITEM_TYPES.map((type) => type.toLowerCase()));


export type ContextUsedItem = {
  workItemId: string;
  title: string;
  workItemType: string;
  source: "explicit" | "linked_requirement" | "stored_project_context" | "llm_selected_context";
  relevanceScore: number;
};

export type AutoContextResolution = {
  selectedContext: LlmContextSource[];
  relatedWorkItems: LlmContextSource[];
  contextUsed: ContextUsedItem[];
  retrievalTopK: number;
};

export async function resolveWorkflowContext(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  provider: LLMProvider;
  targetRequirement: Requirement;
  selectedContextIds?: string[];
  retrievalTopK: number;
  workflowType: "requirement_analysis" | "test_case_generation";
}): Promise<AutoContextResolution> {
  const scope = assertProjectScope(input.scope);
  const retrievalTopK = clampTopK(input.retrievalTopK);
  const linkedRequirementContext = await loadLinkedRequirementContext({
    scope,
    adapter: input.adapter,
    targetRequirement: input.targetRequirement,
  });

  if (input.selectedContextIds?.length) {
    const explicitContext = await loadExplicitContext({
      scope,
      adapter: input.adapter,
      selectedContextIds: input.selectedContextIds,
      retrievalTopK: Math.max(retrievalTopK, input.selectedContextIds.length * 3),
    });
    return {
      selectedContext: explicitContext,
      relatedWorkItems: linkedRequirementContext,
      contextUsed: explicitContext.map((item) => toContextUsedItem(item, "explicit")),
      retrievalTopK,
    };
  }

  const storedContext = distinctContextByWorkItem(
    retrieveStoredProjectContext({
      scope,
      query: requirementToRetrievalQuery(input.targetRequirement),
      topK: retrievalTopK,
    }).filter((item) => item.workItemId !== input.targetRequirement.id),
  );
  const candidates = distinctContextByWorkItem([
    ...linkedRequirementContext,
    ...storedContext,
  ]).slice(0, Math.max(retrievalTopK, linkedRequirementContext.length));

  if (!candidates.length) {
    return {
      selectedContext: [],
      relatedWorkItems: linkedRequirementContext,
      contextUsed: [],
      retrievalTopK,
    };
  }

  const llmSelected = await selectContextWithLLM({
    scope,
    provider: input.provider,
    targetRequirement: input.targetRequirement,
    candidates,
    maxContextItems: retrievalTopK,
    workflowType: input.workflowType,
  });
  const selectedContext = llmSelected.length ? llmSelected : candidates.slice(0, retrievalTopK);
  const llmSelectedIds = new Set(llmSelected.map((item) => item.workItemId));

  return {
    selectedContext,
    relatedWorkItems: linkedRequirementContext,
    contextUsed: selectedContext.map((item) =>
      toContextUsedItem(
        item,
        llmSelectedIds.has(item.workItemId)
          ? "llm_selected_context"
          : linkedRequirementContext.some((linked) => linked.workItemId === item.workItemId)
            ? "linked_requirement"
            : "stored_project_context",
      ),
    ),
    retrievalTopK,
  };
}

export function isRequirementContextWorkItem(item: Pick<Requirement, "workItemType">) {
  return REQUIREMENT_CONTEXT_TYPES.has(item.workItemType.trim().toLowerCase());
}

async function loadLinkedRequirementContext(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  targetRequirement: Requirement;
}) {
  const linked = await input.adapter.fetchLinkedRequirementWorkItems({
    projectId: input.scope.azureProjectId,
    workItemId: input.targetRequirement.id,
    workItemTypes: REQUIREMENT_CONTEXT_WORK_ITEM_TYPES,
  });
  return linked
    .filter(isRequirementContextWorkItem)
    .filter((item) => item.id !== input.targetRequirement.id)
    .map((item) => workItemToLlmContextSource(item, 1));
}

async function loadExplicitContext(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  selectedContextIds: string[];
  retrievalTopK: number;
}) {
  const stored = retrieveStoredProjectContext({
    scope: input.scope,
    query: input.selectedContextIds.join(" "),
    workItemIds: input.selectedContextIds,
    topK: input.retrievalTopK,
  });
  const foundIds = new Set(stored.map((item) => item.workItemId));
  const missingIds = input.selectedContextIds.filter((id) => !foundIds.has(id));
  if (!missingIds.length) return distinctContextByWorkItem(stored);

  const fetched = await Promise.all(
    missingIds.map((workItemId) =>
      input.adapter.fetchWorkItemById({ projectId: input.scope.azureProjectId, workItemId }),
    ),
  );
  return distinctContextByWorkItem([
    ...stored,
    ...fetched.map((item) => workItemToLlmContextSource(item)),
  ]);
}

async function selectContextWithLLM(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: Requirement;
  candidates: LlmContextSource[];
  maxContextItems: number;
  workflowType: "requirement_analysis" | "test_case_generation";
}) {
  try {
    const result = await suggestContextStories({
      scope: input.scope,
      provider: input.provider,
      targetRequirement: input.targetRequirement,
      retrievedContext: input.candidates,
      maxContextItems: input.maxContextItems,
      action: `${input.workflowType}.auto_context_select`,
    });
    const ids = new Set(result.validatedOutput.suggestedItems.map((item) => item.workItemId));
    return input.candidates.filter((item) => ids.has(item.workItemId)).slice(0, input.maxContextItems);
  } catch (error) {
    console.error("Internal LLM context selection failed; falling back to deterministic context retrieval.", error);
    return [];
  }
}

function distinctContextByWorkItem(items: LlmContextSource[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.workItemId || seen.has(item.workItemId)) return false;
    seen.add(item.workItemId);
    return true;
  });
}

function toContextUsedItem(item: LlmContextSource, source: ContextUsedItem["source"]): ContextUsedItem {
  return {
    workItemId: item.workItemId,
    title: item.title,
    workItemType: item.workItemType,
    source,
    relevanceScore: item.relevanceScore,
  };
}

function clampTopK(value: number) {
  if (!Number.isFinite(value)) return 8;
  return Math.min(25, Math.max(1, Math.round(value)));
}
