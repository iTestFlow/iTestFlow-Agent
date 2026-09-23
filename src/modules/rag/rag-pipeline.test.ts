import { describe, expect, it, vi } from "vitest";

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));

import { projectScope } from "@/test/factories";
import { ProjectKnowledgeBaseSchema } from "./project-knowledge.schema";
import { LocalKeywordVectorStore } from "./local-vector-store";
import { chunkText, indexProjectContext, retrieveProjectContext } from "./rag-pipeline.service";
import {
  buildWorkflowContextCitations,
  normalizeWorkflowContextReason,
  WorkflowContextCitationSchema,
} from "./workflow-context-citations";

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

  it("overlaps consecutive chunks so boundary-straddling text survives in one piece", () => {
    const chunks = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text: "abcdefghij",
      chunkSize: 5,
      chunkOverlap: 2,
    });
    // step = chunkSize - overlap = 3: chunk1 starts at index 3, chunk2 at index 6.
    // The text is only 10 chars, so the final chunk is a shorter 4-char tail
    // ("ghij"), not a full 5-char window — it still carries new content ("ij")
    // beyond the previous chunk, so it is not a redundant subset.
    expect(chunks.map((chunk) => chunk.content)).toEqual(["abcde", "defgh", "ghij"]);
    expect(chunks.map((chunk) => chunk.metadata.chunkIndex)).toEqual([0, 1, 2]);
  });

  it("applies the default 200-char overlap at the default chunk size", () => {
    const text = "x".repeat(1900) + "y".repeat(200);
    const chunks = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text,
    });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.content).toHaveLength(2000);
    expect(chunks[0]!.content.slice(-200)).toBe(chunks[1]!.content.slice(0, 200));
    expect(chunks[1]!.content.endsWith("y".repeat(200))).toBe(true);
  });

  it("breaks chunks on word boundaries instead of mid-word", () => {
    // A blind character cut produces fragments that are junk tokens for full-text
    // search and shift the chunk's embedding away from its real meaning.
    const text = "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    const chunks = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text,
      chunkSize: 20,
      chunkOverlap: 0,
    });

    for (const chunk of chunks) {
      // Every chunk is made of whole words from the original text.
      for (const word of chunk.content.split(/\s+/).filter(Boolean)) {
        expect(text.split(/\s+/)).toContain(word);
      }
    }
  });

  it("prefers a sentence boundary over a bare word boundary", () => {
    // The boundary search looks back a bounded fraction of the chunk size, so the
    // sentence end has to fall inside that window for it to win over a plain space.
    const text = `${"filler ".repeat(10)}the sentence ends here. and then the text continues well beyond`;
    const [first] = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text,
      chunkSize: 95,
      chunkOverlap: 0,
    });
    expect(first!.content.endsWith(".")).toBe(true);
    expect(first!.content).toContain("the sentence ends here.");
  });

  it("loses no text when shortening a chunk to a clean boundary", () => {
    // Regression guard: the stride must follow the actual break point, not a fixed
    // size, or the characters between the break and the nominal stride vanish.
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
    const chunks = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text,
      chunkSize: 40,
      chunkOverlap: 0,
    });

    const seen = new Set(chunks.flatMap((chunk) => chunk.content.split(/\s+/).filter(Boolean)));
    for (const word of text.split(" ")) expect(seen).toContain(word);
  });

  it("still cuts at the hard limit when there is no boundary to find", () => {
    // One unbroken run (a base64 blob) must not collapse chunks to a tiny size.
    const text = "z".repeat(500);
    const chunks = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text,
      chunkSize: 100,
      chunkOverlap: 0,
    });
    expect(chunks).toHaveLength(5);
    expect(chunks[0]!.content).toHaveLength(100);
  });

  it("never emits a trailing chunk that is a pure subset of the previous one", () => {
    const exactFit = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text: "abcde",
      chunkSize: 5,
      chunkOverlap: 2,
    });
    expect(exactFit.map((chunk) => chunk.content)).toEqual(["abcde"]);

    expect(chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text: "",
    })).toEqual([]);
  });

  it("clamps an oversized overlap below the chunk size so the window always advances", () => {
    const chunks = chunkText({
      projectId: "p",
      azureProjectId: "a",
      sourceId: "WI:1",
      sourceType: "azure_work_item",
      title: "Story",
      text: "abcdef",
      chunkSize: 3,
      chunkOverlap: 99,
    });
    expect(chunks.map((chunk) => chunk.content)).toEqual(["abc", "bcd", "cde", "def"]);
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
      reason: "Selected for this story.",
      workItemId: "1",
      workItemType: "User Story",
    }]);
  });

  it("adds selected story attachment citations alongside project context", () => {
    const citations = buildWorkflowContextCitations({
      resolvedContextUsed: [
        { workItemId: "1", title: "Story", workItemType: "User Story", source: "explicit", relevanceScore: 1 },
      ],
      storyAttachments: [
        { id: "attachment-payment-design", fileName: "payment-design.pdf", mimeType: "application/pdf", visualCount: 2 },
      ],
    });

    expect(citations).toContainEqual({
      sourceType: "story_attachment",
      sourceId: "SA:attachment-payment-design",
      title: "payment-design.pdf",
      reason: "Attached to this story.",
      attachmentId: "attachment-payment-design",
      fileName: "payment-design.pdf",
      mimeType: "application/pdf",
      visualCount: 2,
    });
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
      chatInsights: [
        {
          id: "chat-1",
          title: "Checkout discussion",
          content: "A synthesis of the checkout discussion.",
          sourceWorkItemIds: ["15"],
          evidence: "WI 15",
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
      "KB:chat_insight:chat-1",
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
      reason: "Derived from related story WI:10.",
      category: "module",
      sourceWorkItemIds: ["10"],
    });
    expect(byId.get("KB:business_rule:rule-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:business_rule:rule-1",
      title: "Orders over 100 require approval",
      reason: "Derived from related story WI:11.",
      category: "business_rule",
      sourceWorkItemIds: ["11"],
    });
    expect(byId.get("KB:state_transition:trans-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:state_transition:trans-1",
      title: "Order Lifecycle: Pending -> Shipped",
      reason: "Derived from related story WI:12.",
      category: "state_transition",
      sourceWorkItemIds: ["12"],
    });
    expect(byId.get("KB:glossary:Cart")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:glossary:Cart",
      title: "Cart",
      reason: "Derived from related story WI:13.",
      category: "glossary",
      sourceWorkItemIds: ["13"],
    });
    expect(byId.get("KB:dependency:dep-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:dependency:dep-1",
      title: "Billing -> Notifications",
      reason: "Derived from related story WI:14.",
      category: "dependency",
      sourceWorkItemIds: ["14"],
    });
    expect(byId.get("KB:chat_insight:chat-1")).toEqual({
      sourceType: "project_knowledge",
      sourceId: "KB:chat_insight:chat-1",
      title: "Checkout discussion",
      reason: "Derived from related story WI:15.",
      category: "chat_insight",
      sourceWorkItemIds: ["15"],
    });

    // Context citations are still emitted alongside knowledge citations.
    expect(byId.get("WI:1")).toEqual({
      sourceType: "project_context",
      sourceId: "WI:1",
      title: "Story",
      reason: "Selected for this story.",
      workItemId: "1",
      workItemType: "User Story",
    });

    // Dedup collapsed the duplicate mod-1 module: first occurrence kept, no dupes.
    expect(byId.size).toBe(citations.length);
  });

  it("normalizes concise reasons while accepting citations recorded before reasons existed", () => {
    expect(normalizeWorkflowContextReason(
      " This is relevant because it covers the payment authorization flow. A second sentence is not shown.",
      "Fallback reason.",
    )).toBe("This is relevant because it covers the payment authorization flow.");
    expect(normalizeWorkflowContextReason("x".repeat(300), "Fallback reason.")).toHaveLength(160);

    expect(WorkflowContextCitationSchema.parse({
      sourceType: "project_context",
      sourceId: "WI:legacy",
      title: "Legacy reference",
      workItemId: "legacy",
      workItemType: "User Story",
    })).not.toHaveProperty("reason");
  });


});
