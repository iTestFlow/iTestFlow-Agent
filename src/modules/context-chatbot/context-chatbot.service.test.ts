import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieveEvidence = vi.hoisted(() => vi.fn());

vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({
  retrieveContextChatbotEvidence: retrieveEvidence,
}));
vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: vi.fn(),
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
  });
});
