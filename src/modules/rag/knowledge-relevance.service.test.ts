import { beforeEach, describe, expect, it, vi } from "vitest";

const searchByEmbedding = vi.hoisted(() => vi.fn());

vi.mock("@/modules/rag/embedding-store.service", () => ({
  searchProjectKnowledgeByEmbedding: searchByEmbedding,
}));
vi.mock("@/modules/rag/embedding-provider", () => ({
  createEmbeddingProvider: () => ({
    name: "local",
    model: "stub",
    vectorReference: "stub",
    embed: async (texts: string[]) => texts.map(() => [1, 0]),
  }),
}));

import { projectScope } from "@/test/factories";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import { rankProjectKnowledgeByRelevance } from "@/modules/rag/knowledge-relevance.service";

/**
 * The contract that matters here is degradation. This ranking is an improvement layered
 * over keyword ranking, never a dependency: every failure path must return null so the
 * caller falls back, because a throw here would take down a whole workflow run for a
 * retrieval refinement.
 */

function knowledgeBase(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "billing",
      name: "Billing",
      description: "Billing module",
      sourceWorkItemIds: ["1"],
      evidence: "e",
    }],
    businessRules: [{
      id: "rule-1",
      rule: "Refunds need approval",
      sourceField: "description",
      moduleName: "Billing",
      sourceWorkItemIds: ["1"],
      evidence: "e",
    }],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  });
}

const baseInput = () => ({
  scope: projectScope(),
  projectKnowledgeBase: knowledgeBase(),
  queryText: "refund approval rules",
  relatedWorkItemIds: ["1"],
});

beforeEach(() => vi.clearAllMocks());

describe("rankProjectKnowledgeByRelevance", () => {
  it("returns null when there is no compiled knowledge to rank", async () => {
    await expect(rankProjectKnowledgeByRelevance({ ...baseInput(), projectKnowledgeBase: null }))
      .resolves.toBeNull();
    expect(searchByEmbedding).not.toHaveBeenCalled();
  });

  it("returns null for a blank query without touching the index", async () => {
    await expect(rankProjectKnowledgeByRelevance({ ...baseInput(), queryText: "   " }))
      .resolves.toBeNull();
    expect(searchByEmbedding).not.toHaveBeenCalled();
  });

  it("degrades to keyword ranking instead of throwing when the vector search fails", async () => {
    // The load-bearing case: an embedding outage must cost precision, not the whole run.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    searchByEmbedding.mockRejectedValue(new Error("pgvector unavailable"));

    await expect(rankProjectKnowledgeByRelevance(baseInput())).resolves.toBeNull();

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("returns null when the index has nothing for this project yet", async () => {
    searchByEmbedding.mockResolvedValue([]);

    await expect(rankProjectKnowledgeByRelevance(baseInput())).resolves.toBeNull();
  });

  it("ignores stored categories it does not recognise rather than mis-filing them", async () => {
    // A future category reaching an older deployment must not be silently bucketed into
    // an existing one, which would put unrelated entries in a prompt section.
    searchByEmbedding.mockResolvedValue([
      { entry_key: "rule-1", category: "business_rule", similarity: 0.9 },
      { entry_key: "mystery", category: "not_a_real_category", similarity: 0.95 },
    ]);

    const result = await rankProjectKnowledgeByRelevance(baseInput());

    expect(JSON.stringify(result ?? {})).not.toContain("mystery");
  });

  it("selects entries the graph connects even when they are not the top similarity", async () => {
    searchByEmbedding.mockResolvedValue([
      { entry_key: "rule-1", category: "business_rule", similarity: 0.62 },
      { entry_key: "billing", category: "module", similarity: 0.61 },
    ]);

    const result = await rankProjectKnowledgeByRelevance(baseInput());

    // Both are reachable from work item 1 via provenance, so neither is dropped for
    // scoring below a purely similarity-based bar.
    expect(result?.businessRules ?? []).toContain("rule-1");
  });

  it("distinguishes a scored-but-fully-cut category from one that was never scored", async () => {
    // Keys deliberately absent from the fixture ontology so nothing is rescued by
    // connection: with similarities 0.9/0.2 the bar sits at 0.55, so the module entry
    // is cut. Its category must still arrive as an explicit empty array — the renderer
    // reads that as "send nothing", whereas an absent key (glossary here) means "keep
    // keyword ranking".
    searchByEmbedding.mockResolvedValue([
      { entry_key: "rule-x", category: "business_rule", similarity: 0.9 },
      { entry_key: "mod-x", category: "module", similarity: 0.2 },
    ]);

    const result = await rankProjectKnowledgeByRelevance(baseInput());

    expect(result?.businessRules).toEqual(["rule-x"]);
    expect(result?.modules).toEqual([]);
    expect(result && "glossary" in result).toBe(false);
  });
});
