import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieveEvidence = vi.hoisted(() => vi.fn());
const recordBenchmarkQuestion = vi.hoisted(() => vi.fn());

vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({
  retrieveContextChatbotEvidence: retrieveEvidence,
}));
vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));
vi.mock("@/modules/rag/project-knowledge-benchmark.service", () => ({
  recordProjectKnowledgeBenchmarkQuestion: recordBenchmarkQuestion,
}));

import { fakeLlmProvider, projectScope } from "@/test/factories";
import { answerContextChatbot } from "./context-chatbot.service";

describe("context chatbot service", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects blank questions before retrieval", async () => {
    await expect(answerContextChatbot({
      scope: projectScope(),
      actor: "qa",
      provider: fakeLlmProvider(),
      message: " ",
    })).rejects.toThrow("Enter a question");
    expect(retrieveEvidence).not.toHaveBeenCalled();
  });

  it("returns a local no-evidence answer without calling the LLM", async () => {
    retrieveEvidence.mockResolvedValue({ context: [], knowledge: [] });
    const provider = fakeLlmProvider();
    const result = await answerContextChatbot({
      scope: projectScope(),
      actor: "qa",
      provider,
      message: "What is checkout?",
    });
    expect(result.answer).toContain("could not find enough information");
    expect(result.citations).toEqual([]);
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  it("deduplicates citations and restricts generation to retrieved evidence", async () => {
    retrieveEvidence.mockResolvedValue({
      context: [{
        sourceId: "WI:1",
        title: "Checkout",
        workItemId: "1",
        workItemType: "Story",
        content: "Checkout requires payment.",
        metadata: {},
      }, {
        sourceId: "WI:1",
        title: "Checkout duplicate",
        workItemId: "1",
        workItemType: "Story",
        content: "Duplicate chunk.",
        metadata: {},
      }],
      knowledge: [{
        sourceId: "KB:rule:1",
        title: "Payment rule",
        category: "business_rule",
        sourceWorkItemIds: ["1"],
        content: "Payment is required.",
      }],
    });
    const provider = fakeLlmProvider({ text: "Use payment [WI:1]." });
    const result = await answerContextChatbot({
      scope: projectScope(),
      actor: "qa",
      provider,
      message: "How does checkout work?",
      history: [{ role: "user", content: "Earlier question" }],
    });
    expect(result.citations).toHaveLength(2);
    expect(result.answer).toContain("[WI:1]");
    expect(provider.generateText).toHaveBeenCalledWith(expect.objectContaining({
      maxTokens: 2500,
      system: expect.stringContaining("Use ONLY"),
      user: expect.stringContaining("Checkout requires payment"),
    }));
    // Regression: two context chunks share sourceId "WI:1" (same work item, different
    // chunks) and dedupe to one citation card, so retrievedContextCount must reflect
    // the deduped count (1), not the raw chunk count (2) — otherwise the sum of the
    // breakdown overshoots citations.length.
    expect(result.retrievedContextCount).toBe(1);
    expect(result.retrievedKnowledgeCount).toBe(1);
    expect(result.linkedWorkItemCount).toBe(0);
    expect(result.retrievedContextCount + result.retrievedKnowledgeCount + result.linkedWorkItemCount).toBe(
      result.citations.length,
    );
  });

  it("adds knowledge source work items as clickable work-item citations", async () => {
    retrieveEvidence.mockResolvedValue({
      context: [{
        sourceId: "WI:1",
        title: "Checkout",
        workItemId: "1",
        workItemType: "Story",
        content: "Checkout requires payment.",
        metadata: {},
      }],
      knowledge: [{
        sourceId: "KB:rule:payment",
        title: "Payment rule",
        category: "business_rule",
        sourceWorkItemIds: ["1", "2", "WI:3"],
        content: "Payment is required.",
      }],
    });
    const provider = fakeLlmProvider({ text: "Payment is covered by WI:2 and WI:3." });

    const result = await answerContextChatbot({
      scope: projectScope(),
      actor: "qa",
      provider,
      message: "What are the payment rules?",
    });
    expect(recordBenchmarkQuestion).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "business_owner_assistant",
      question: "What are the payment rules?",
    }));

    expect(result.citations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceId: "WI:1",
        title: "Checkout",
        workItemType: "Story",
      }),
      expect.objectContaining({
        sourceId: "WI:2",
        title: "Source work item 2",
        workItemId: "2",
        workItemType: "Work item",
      }),
      expect.objectContaining({
        sourceId: "WI:3",
        workItemId: "3",
      }),
      expect.objectContaining({
        sourceId: "KB:rule:payment",
      }),
    ]));
    expect(result.citations).toHaveLength(4);
    expect(result.retrievedContextCount).toBe(1);
    expect(result.retrievedKnowledgeCount).toBe(1);
    expect(result.linkedWorkItemCount).toBe(2);
    expect(result.retrievedContextCount + result.retrievedKnowledgeCount + result.linkedWorkItemCount).toBe(
      result.citations.length,
    );
  });
});
