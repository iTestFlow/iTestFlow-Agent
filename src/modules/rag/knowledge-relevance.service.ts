import "server-only";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createEmbeddingProvider } from "./embedding-provider";
import { searchProjectKnowledgeByEmbedding } from "./embedding-store.service";
import {
  buildKnowledgeOntology,
  resolveConnectedEntries,
  type OntologyCategory,
} from "./knowledge-ontology";
import {
  hasAnyRelevantEntry,
  selectRelevantEntries,
  type RelevanceSelection,
  type ScoredEntry,
} from "./knowledge-relevance-cutoff";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { requirementToRetrievalQuery } from "./project-context-store.service";
import type { ProjectKnowledgeBase } from "./project-knowledge.schema";

/**
 * Chooses which compiled knowledge a workflow prompt should carry for a given work item.
 *
 * Workflow prompts ranked knowledge by keyword overlap against the work item. That is
 * adequate only while the whole knowledge base fits in the window and ranking merely
 * decides ordering. Once the corpus outgrows the budget, ranking decides *inclusion*,
 * and keyword overlap is a poor instrument for it: a rule phrased "authorisation" never
 * surfaces for a work item about "permissions", and the excluded rule is invisible —
 * nothing in the output says a relevant condition was dropped.
 *
 * Two signals replace it, neither sufficient alone:
 *
 * - **Similarity**, reusing the entry embeddings that already exist for the Business
 *   Owner Assistant (`source_type = 'project_knowledge_entry'`), so no new index.
 * - **The project's own ontology** — module membership, extraction provenance, and
 *   declared dependencies between modules — which catches knowledge that is relevant
 *   through structure rather than wording.
 *
 * Returns the entry keys worth sending per category. The prompt renderer treats that as
 * the eligible set for a category, not merely an ordering.
 *
 * Degrades to `null` on failure or when nothing qualifies, leaving the caller on keyword
 * ranking. Better selection is an improvement, never a dependency.
 */

export type RankedKnowledgeKeys = RelevanceSelection;

const CATEGORY_BY_STORED_NAME: Record<string, OntologyCategory> = {
  module: "modules",
  business_rule: "businessRules",
  state_transition: "stateTransitions",
  glossary: "glossary",
  dependency: "crossDependencies",
  chat_insight: "chatInsights",
};

/**
 * Upper bound on entries scored. Generous because this only decides what the token
 * budget later trims, and the cost is one query embedding plus an in-process scan the
 * assistant already performs per message.
 */
const MAX_RANKED_ENTRIES = 2_000;

export async function rankProjectKnowledgeByRelevance(input: {
  scope: ProjectScope;
  /** Compiled knowledge, which supplies the relationship graph. */
  projectKnowledgeBase: ProjectKnowledgeBase | null | undefined;
  /** Text of the work item under analysis: title, description, criteria, area path. */
  queryText: string;
  /** The work item's own id, plus anything Azure DevOps links it to. */
  relatedWorkItemIds?: string[];
}): Promise<RankedKnowledgeKeys | null> {
  const queryText = input.queryText.trim();
  if (!queryText || !input.projectKnowledgeBase) return null;

  try {
    const ranked = await searchProjectKnowledgeByEmbedding({
      scope: input.scope,
      provider: createEmbeddingProvider(),
      query: queryText,
      topK: MAX_RANKED_ENTRIES,
    });
    if (!ranked.length) return null;

    // The embedding index may still contain entries removed for this request.
    // They must not affect cutoff scores or the renderer's eligible-key lists.
    const allowedKeys = knowledgeKeysByCategory(input.projectKnowledgeBase);
    const scored: ScoredEntry[] = [];
    for (const entry of ranked) {
      const category = CATEGORY_BY_STORED_NAME[entry.category];
      if (!category || !allowedKeys[category].has(entry.entry_key)) continue;
      scored.push({ key: entry.entry_key, category, similarity: entry.similarity });
    }

    if (!scored.length) return null;

    const ontology = buildKnowledgeOntology(input.projectKnowledgeBase);
    const connected = resolveConnectedEntries(ontology, {
      workItemIds: input.relatedWorkItemIds ?? [],
      text: queryText,
    });

    const selection = selectRelevantEntries(scored, connected);
    return hasAnyRelevantEntry(selection) ? selection : null;
  } catch (error) {
    // Keyword ranking remains correct, just less discerning.
    console.error("Semantic knowledge ranking failed; falling back to keyword ranking.", error);
    return null;
  }
}

function knowledgeKeysByCategory(knowledgeBase: ProjectKnowledgeBase): Record<OntologyCategory, Set<string>> {
  return {
    modules: new Set(knowledgeBase.modules.map((entry) => entry.id)),
    businessRules: new Set(knowledgeBase.businessRules.map((entry) => entry.id)),
    stateTransitions: new Set(knowledgeBase.stateTransitions.map((entry) => entry.id)),
    glossary: new Set(knowledgeBase.glossary.map((entry) => entry.term)),
    crossDependencies: new Set(knowledgeBase.crossDependencies.map((entry) => entry.id)),
    chatInsights: new Set(knowledgeBase.chatInsights.map((entry) => entry.id)),
  };
}

/**
 * Convenience wrapper for the four workflow routes: derives the query text and the
 * anchor work item ids from what a workflow already has in hand.
 *
 * Related and selected context items anchor the ontology alongside the target itself.
 * They were chosen as relevant to this work item by linkage or retrieval, so knowledge
 * extracted from them is relevant by the same reasoning.
 */
export async function rankProjectKnowledgeForWorkItem(input: {
  scope: ProjectScope;
  targetRequirement: Requirement;
  projectKnowledgeBase: ProjectKnowledgeBase | null | undefined;
  contextWorkItemIds?: string[];
}): Promise<RankedKnowledgeKeys | null> {
  const { targetRequirement } = input;
  return rankProjectKnowledgeByRelevance({
    scope: input.scope,
    projectKnowledgeBase: input.projectKnowledgeBase,
    // Area path and iteration path are included because they are where a board states
    // module membership when the text does not.
    queryText: [
      requirementToRetrievalQuery(targetRequirement),
      targetRequirement.areaPath ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
    relatedWorkItemIds: [targetRequirement.id, ...(input.contextWorkItemIds ?? [])],
  });
}
