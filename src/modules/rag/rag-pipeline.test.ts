import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { projectScope } from "@/test/factories";
import { ProjectKnowledgeBaseSchema } from "./project-knowledge.schema";
import { LocalKeywordVectorStore } from "./local-vector-store";
import { chunkText, indexProjectContext, retrieveProjectContext } from "./rag-pipeline.service";
import { buildWorkflowContextCitations } from "./workflow-context-citations";

describe("RAG pipeline", () => {
  it("chunks text deterministically and records indexes", () => {
    expect(chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text: "abcdefgh",
      chunkSize: 3,
    })).toEqual([
      expect.objectContaining({ id: "WI:1-0", content: "abc", metadata: { chunkIndex: 0 } }),
      expect.objectContaining({ id: "WI:1-1", content: "def", metadata: { chunkIndex: 1 } }),
      expect.objectContaining({ id: "WI:1-2", content: "gh", metadata: { chunkIndex: 2 } }),
    ]);
  });

  it("upserts by ID, isolates projects, ranks matches, and honors topK", async () => {
    const store = new LocalKeywordVectorStore();
    await store.upsert([
      { id: "1", projectId: "p", azureProjectId: "a", sourceId: "1", sourceType: "azure_work_item", title: "A", content: "checkout payment card", metadata: { chunkIndex: 0 } },
      { id: "2", projectId: "p", azureProjectId: "a", sourceId: "2", sourceType: "azure_work_item", title: "B", content: "checkout only", metadata: { chunkIndex: 0 } },
      { id: "3", projectId: "other", azureProjectId: "a", sourceId: "3", sourceType: "azure_work_item", title: "C", content: "checkout payment", metadata: { chunkIndex: 0 } },
    ]);
    await store.upsert([
      { id: "2", projectId: "p", azureProjectId: "a", sourceId: "2", sourceType: "azure_work_item", title: "B2", content: "payment", metadata: { chunkIndex: 0 } },
    ]);
    const result = await store.search({
      projectId: "p", azureProjectId: "a", query: "checkout payment", topK: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "1", score: 1 });
  });

  it("indexes and retrieves only trusted-scope chunks", async () => {
    const store = new LocalKeywordVectorStore();
    const chunks = chunkText({
      projectId: "project-1",
      azureProjectId: "azure-project-1",
      sourceId: "1",
      sourceType: "azure_work_item",
      title: "Story",
      text: "checkout payment",
    });
    await indexProjectContext({ scope: projectScope(), actor: "qa", vectorStore: store, chunks });
    await expect(retrieveProjectContext({
      scope: projectScope(), vectorStore: store, query: "checkout", topK: 2,
    })).resolves.toHaveLength(1);
    await expect(indexProjectContext({
      scope: projectScope(),
      actor: "qa",
      vectorStore: store,
      chunks: [{ ...chunks[0]!, projectId: "other" }],
    })).rejects.toThrow("outside the selected");
  });

  it("deduplicates workflow citations by stable source ID", () => {
    const citations = buildWorkflowContextCitations({
      resolvedContextUsed: [
        { workItemId: "1", title: "Story", workItemType: "User Story", source: "explicit", relevanceScore: 1 },
        { workItemId: "1", title: "Duplicate", workItemType: "User Story", source: "llm_selected_context", relevanceScore: 0.8 },
      ],
    });
    expect(citations).toEqual([{
      sourceType: "project_context",
      sourceId: "WI:1",
      title: "Story",
      workItemId: "1",
      workItemType: "User Story",
    }]);
  });

  it("emits a knowledge citation per category and dedups KB source ID collisions", () => {
    const knowledgeBase = ProjectKnowledgeBaseSchema.parse({
      modules: [
        { id: "mod-1", name: "Checkout", description: "Checkout module", sourceWorkItemIds: ["10"], evidence: "WI 10" },
        // Same id as mod-1 -> same KB:module:mod-1 source ID; first occurrence wins.
        { id: "mod-1", name: "Checkout Duplicate", description: "Dup", sourceWorkItemIds: ["99"], evidence: "WI 99" },
      ],
      businessRules: [
        { id: "rule-1", rule: "Orders over 100 require approval", sourceField: "acceptanceCriteria", sourceWorkItemIds: ["11"], evidence: "WI 11" },
      ],
      stateTransitions: [
        {
          id: "trans-1",
          workflowName: "Order Lifecycle",
          fromState: "Pending",
          toState: "Shipped",
          triggerOrCondition: "Payment captured",
          sourceWorkItemIds: ["12"],
          evidence: "WI 12",
        },
      ],
      glossary: [
        { term: "Cart", type: "business_entity", definition: "A customer shopping cart", sourceWorkItemIds: ["13"], evidence: "WI 13" },
      ],
      crossDependencies: [
        {
          id: "dep-1",
          sourceModule: "Billing",
          targetModule: "Notifications",
          dependencyType: "calls",
          description: "Billing notifies Notifications",
          sourceWorkItemIds: ["14"],
          evidence: "WI 14",
        },
      ],
    });

    const citations = buildWorkflowContextCitations({
      resolvedContextUsed: [
        { workItemId: "1", title: "Story", workItemType: "User Story", source: "explicit", relevanceScore: 1 },
      ],
      relevantProjectKnowledgeBase: knowledgeBase,
    });

    const byId = new Map(citations.map((citation) => [citation.sourceId, citation]));

    // Context citation plus one KB:<category>:<key> citation for every category.
    // The duplicate mod-1 entry collapsed into a single KB:module:mod-1.
    expect([...byId.keys()].sort()).toEqual([
      "KB:business_rule:rule-1",
      "KB:dependency:dep-1",
      "KB:glossary:Cart",
      "KB:module:mod-1",
      "KB:state_transition:trans-1",
      "WI:1",
    ]);

    // Citation shape matches toKnowledgeCitation output for each category.
    expect(byId.get("KB:module:mod-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:module:mod-1",
      title: "Checkout",
      category: "module",
      sourceWorkItemIds: ["10"],
    });
    expect(byId.get("KB:business_rule:rule-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:business_rule:rule-1",
      title: "Orders over 100 require approval",
      category: "business_rule",
      sourceWorkItemIds: ["11"],
    });
    expect(byId.get("KB:state_transition:trans-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:state_transition:trans-1",
      title: "Order Lifecycle: Pending -> Shipped",
      category: "state_transition",
      sourceWorkItemIds: ["12"],
    });
    expect(byId.get("KB:glossary:Cart")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:glossary:Cart",
      title: "Cart",
      category: "glossary",
      sourceWorkItemIds: ["13"],
    });
    expect(byId.get("KB:dependency:dep-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:dependency:dep-1",
      title: "Billing -> Notifications",
      category: "dependency",
      sourceWorkItemIds: ["14"],
    });

    // Context citations are still emitted alongside knowledge citations.
    expect(byId.get("WI:1")).toEqual({
      sourceType: "project_context",
      sourceId: "WI:1",
      title: "Story",
      workItemId: "1",
      workItemType: "User Story",
    });

    // Dedup collapsed the duplicate mod-1 module: first occurrence kept, no dupes.
    expect(byId.size).toBe(citations.length);
  });


});
