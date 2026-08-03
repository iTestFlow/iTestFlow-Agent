import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieveEvidence = vi.hoisted(() => vi.fn());

vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({
  retrieveContextChatbotEvidence: retrieveEvidence,
}));
vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
}));
// Deterministic stand-in for the local embedding model: a text is "relevant" iff it
// mentions escalation. Keeps this file hermetic — the real weights are ~131 MB.
vi.mock("@/modules/rag/embedding-provider", () => ({
  createEmbeddingProvider: () => ({
    name: "local",
    model: "stub",
    vectorReference: "stub",
    embed: async (texts: string[]) =>
      texts.map((text) => (/escalation/i.test(text) ? [1, 0] : [0, 1])),
  }),
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

  it("keeps an older but relevant exchange in the prompt, past the recent window", async () => {
    // The regression this guards: conversation memory recovers older relevant exchanges,
    // but the renderer then re-sliced to the most recent N. Recovered exchanges are older
    // by definition, so a trailing slice removed exactly them and the feature silently
    // degraded to pure recency. Needs a history longer than that old window to show it.
    const OLD_FACT = "escalation above the ceiling goes to the regional manager";
    const history = [
      { role: "user" as const, content: `What is the ${OLD_FACT}?` },
      { role: "assistant" as const, content: `Noted: ${OLD_FACT}.` },
      ...Array.from({ length: 12 }, (_, index) => ([
        { role: "user" as const, content: `unrelated filler question ${index}` },
        { role: "assistant" as const, content: `unrelated filler answer ${index}` },
      ])).flat(),
    ];

    retrieveEvidence.mockResolvedValue({
      context: [{
        sourceId: "WI:9", title: "Refunds", workItemId: "9", workItemType: "Story",
        content: "Refund rules.", metadata: {},
      }],
      knowledge: [],
    });
    const provider = fakeLlmProvider();

    await answerContextChatbot({
      scope: projectScope(),
      actor: "qa",
      provider,
      message: "remind me about the escalation rule",
      history,
    });

    const userPrompt = vi.mocked(provider.generateText).mock.calls[0]![0].user;
    expect(userPrompt).toContain(OLD_FACT);
  });
});
