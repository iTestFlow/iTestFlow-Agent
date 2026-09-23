import "server-only";

import type { LLMProvider } from "@/modules/llm/llm-types";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { isIntegrationError } from "@/modules/integrations/core/integration-error";
import { suggestContextStories } from "@/modules/context-selection/context-selection.service";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  requirementToRetrievalQuery,
  retrieveStoredProjectContext,
  isWorkItemLlmContextSource,
  workItemToLlmContextSource,
  type LlmWorkItemContextSource,
} from "./project-context-store.service";
import {
  filterWorkItemSourcesForContextControls,
  isWorkflowContextSourceAllowed,
  normalizeWorkflowContextControls,
  sourceIdForWorkItem,
  workItemIdsFromSourceIds,
} from "./workflow-context-controls";

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
  /** A model-provided selection explanation when automatic selection supplied one. */
  reason?: string;
};

export type AutoContextResolution = {
  /**
   * This resolver drives Azure-work-item-specific workflow contracts. Document
   * context is intentionally handled by source-aware RAG/chatbot consumers,
   * not passed into prompts that require a workItemId and workItemType.
   */
  selectedContext: LlmWorkItemContextSource[];
  relatedWorkItems: LlmWorkItemContextSource[];
  contextUsed: ContextUsedItem[];
  retrievalTopK: number;
};

export class ReviewedContextSourceUnavailableError extends Error {
  constructor(readonly sourceId: string) {
    super(`Reviewed context source ${sourceId} is no longer available.`);
    this.name = "ReviewedContextSourceUnavailableError";
  }
}

export async function resolveWorkflowContext(input: {
  scope: ProjectScope;
  actor: string;
  adapter: AzureDevOpsAdapter;
  provider: LLMProvider;
  targetRequirement: Requirement;
  selectedContextIds?: string[];
  reviewedSourceIds?: string[];
  excludedSourceIds?: string[];
  retrievalTopK: number;
  workflowType: "requirement_analysis" | "test_case_generation" | "existing_test_case_review";
}): Promise<AutoContextResolution> {
  return resolveWorkflowContextCore(input);
}

export async function resolveWorkflowContextWithoutLLM(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  targetRequirement: Requirement;
  selectedContextIds?: string[];
  reviewedSourceIds?: string[];
  excludedSourceIds?: string[];
  retrievalTopK: number;
}): Promise<AutoContextResolution> {
  return resolveWorkflowContextCore({
    ...input,
    workflowType: "requirement_analysis",
  });
}

async function resolveWorkflowContextCore(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  provider?: LLMProvider;
  actor?: string;
  targetRequirement: Requirement;
  selectedContextIds?: string[];
  reviewedSourceIds?: string[];
  excludedSourceIds?: string[];
  retrievalTopK: number;
  workflowType: "requirement_analysis" | "test_case_generation" | "existing_test_case_review";
}): Promise<AutoContextResolution> {
  const scope = assertProjectScope(input.scope);
  const retrievalTopK = clampTopK(input.retrievalTopK);
  const controls = normalizeWorkflowContextControls({
    reviewedSourceIds: input.reviewedSourceIds,
    excludedSourceIds: input.excludedSourceIds,
  });

  // An explicit review is authoritative.  It never adds linked items or
  // backfills a missing reviewed reference from automatic retrieval.
  if (controls.reviewedSourceIds !== undefined) {
    const reviewedWorkItemIds = Array.from(new Set(
      workItemIdsFromSourceIds(controls.reviewedSourceIds).filter((workItemId) =>
        workItemId !== input.targetRequirement.id &&
        isWorkflowContextSourceAllowed(sourceIdForWorkItem(workItemId), controls),
      ),
    ));
    if (!reviewedWorkItemIds.length) {
      return {
        selectedContext: [],
        relatedWorkItems: [],
        contextUsed: [],
        retrievalTopK,
      };
    }

    const selectedContext = await loadReviewedContext({
      scope,
      adapter: input.adapter,
      workItemIds: reviewedWorkItemIds,
    });
    return {
      selectedContext,
      relatedWorkItems: [],
      contextUsed: selectedContext.map((item) => toContextUsedItem(item, "explicit")),
      retrievalTopK,
    };
  }

  const linkedRequirementContext = filterWorkItemSourcesForContextControls(
    await loadLinkedRequirementContext({
      scope,
      adapter: input.adapter,
      targetRequirement: input.targetRequirement,
    }),
    controls,
  );

  if (input.selectedContextIds?.length) {
    const selectedContextIds = input.selectedContextIds.filter((workItemId) =>
      workItemId !== input.targetRequirement.id &&
      isWorkflowContextSourceAllowed(sourceIdForWorkItem(workItemId), controls),
    );
    const explicitContext = await loadExplicitContext({
      scope,
      adapter: input.adapter,
      selectedContextIds,
      retrievalTopK: Math.max(retrievalTopK, selectedContextIds.length * 3),
    });
    const selectedContext = mergePinnedContextItems({
      pinned: linkedRequirementContext,
      ranked: explicitContext,
      maxItems: contextBudget(retrievalTopK, linkedRequirementContext.length),
    });
    return {
      selectedContext,
      relatedWorkItems: linkedRequirementContext,
      contextUsed: selectedContext.map((item) =>
        toContextUsedItem(
          item,
          linkedRequirementContext.some((linked) => linked.workItemId === item.workItemId) ? "linked_requirement" : "explicit",
        ),
      ),
      retrievalTopK,
    };
  }

  const storedContext = distinctContextByWorkItem(
    (await retrieveStoredProjectContext({
      scope,
      query: requirementToRetrievalQuery(input.targetRequirement),
      topK: retrievalTopK,
      sourceKinds: ["azure_work_item"],
    }))
      .filter(isWorkItemLlmContextSource)
      .filter((item) => item.workItemId !== input.targetRequirement.id),
  );
  const candidates = distinctContextByWorkItem([
    ...linkedRequirementContext,
    ...filterWorkItemSourcesForContextControls(storedContext, controls),
  ]).slice(0, Math.max(retrievalTopK, linkedRequirementContext.length));

  if (!candidates.length) {
    return {
      selectedContext: [],
      relatedWorkItems: linkedRequirementContext,
      contextUsed: [],
      retrievalTopK,
    };
  }
  const llmSelection = await selectContextWithLLM({
    scope,
    actor: input.actor,
    provider: input.provider,
    targetRequirement: input.targetRequirement,
    candidates,
    maxContextItems: retrievalTopK,
    workflowType: input.workflowType,
  });
  const selectedContext = mergePinnedContextItems({
    pinned: linkedRequirementContext,
    ranked: llmSelection.items.length ? llmSelection.items : candidates.slice(0, retrievalTopK),
    maxItems: contextBudget(retrievalTopK, linkedRequirementContext.length),
  });
  const llmSelectedIds = new Set(llmSelection.items.map((item) => item.workItemId));

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
        llmSelection.reasons.get(item.workItemId),
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
  if (!input.selectedContextIds.length) return [];
  const requestedIds = new Set(input.selectedContextIds);
  const stored = await retrieveStoredProjectContext({
    scope: input.scope,
    query: input.selectedContextIds.join(" "),
    workItemIds: input.selectedContextIds,
    topK: input.retrievalTopK,
    sourceKinds: ["azure_work_item"],
  });
  const workItemContext = stored
    .filter(isWorkItemLlmContextSource)
    .filter((item) => requestedIds.has(item.workItemId));
  const foundIds = new Set(workItemContext.map((item) => item.workItemId));
  const missingIds = input.selectedContextIds.filter((id) => !foundIds.has(id));
  if (!missingIds.length) return distinctContextByWorkItem(workItemContext);

  const fetched = await Promise.all(
    missingIds.map((workItemId) =>
      input.adapter.fetchWorkItemById({ projectId: input.scope.azureProjectId, workItemId }),
    ),
  );
  return distinctContextByWorkItem([
    ...workItemContext,
    ...fetched.map((item) => workItemToLlmContextSource(item)),
  ]);
}

async function selectContextWithLLM(input: {
  scope: ProjectScope;
  provider?: LLMProvider;
  actor?: string;
  targetRequirement: Requirement;
  candidates: LlmWorkItemContextSource[];
  maxContextItems: number;
  workflowType: "requirement_analysis" | "test_case_generation" | "existing_test_case_review";
}): Promise<{ items: LlmWorkItemContextSource[]; reasons: Map<string, string> }> {
  if (!input.provider) return { items: [], reasons: new Map() };
  if (!input.actor) throw new Error("Audit actor is required for LLM context selection.");

  try {
    const result = await suggestContextStories({
      scope: input.scope,
      actor: input.actor,
      provider: input.provider,
      targetRequirement: input.targetRequirement,
      retrievedContext: input.candidates,
      maxContextItems: input.maxContextItems,
      action: `${input.workflowType}.auto_context_select`,
    });
    const reasons = new Map(
      result.validatedOutput.suggestedItems.map((item) => [item.workItemId, item.reason] as const),
    );
    const ids = new Set(reasons.keys());
    const items = input.candidates.filter((item) => ids.has(item.workItemId)).slice(0, input.maxContextItems);
    return {
      items,
      reasons: new Map(items.map((item) => [item.workItemId, reasons.get(item.workItemId) ?? ""])),
    };
  } catch (error) {
    console.error("Internal LLM context selection failed; falling back to deterministic context retrieval.", error);
    return { items: [], reasons: new Map() };
  }
}

/** A review freezes membership, but current content and access come from the source. */
async function loadReviewedContext(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  workItemIds: string[];
}) {
  const fetched = await Promise.all(input.workItemIds.map(async (workItemId) => {
    try {
      return await input.adapter.fetchWorkItemById({
        projectId: input.scope.azureProjectId,
        workItemId,
      });
    } catch (error) {
      if (isIntegrationError(error) &&
        (error.code === "integration_not_found" || error.code === "integration_permission_denied")) {
        throw new ReviewedContextSourceUnavailableError(sourceIdForWorkItem(workItemId));
      }
      throw error;
    }
  }));
  return distinctContextByWorkItem(fetched.map((item) => workItemToLlmContextSource(item)));
}

function distinctContextByWorkItem(items: LlmWorkItemContextSource[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.workItemId || seen.has(item.workItemId)) return false;
    seen.add(item.workItemId);
    return true;
  });
}

function mergePinnedContextItems(input: {
  pinned: LlmWorkItemContextSource[];
  ranked: LlmWorkItemContextSource[];
  maxItems: number;
}) {
  return distinctContextByWorkItem([...input.pinned, ...input.ranked]).slice(0, input.maxItems);
}

function contextBudget(retrievalTopK: number, pinnedCount: number) {
  return Math.min(25, Math.max(retrievalTopK, pinnedCount));
}

function toContextUsedItem(
  item: LlmWorkItemContextSource,
  source: ContextUsedItem["source"],
  reason?: string,
): ContextUsedItem {
  return {
    workItemId: item.workItemId,
    title: item.title,
    workItemType: item.workItemType,
    source,
    relevanceScore: item.relevanceScore,
    ...(reason?.trim() ? { reason } : {}),
  };
}

function clampTopK(value: number) {
  if (!Number.isFinite(value)) return 8;
  return Math.min(25, Math.max(1, Math.round(value)));
}
