import { describe, expect, it } from "vitest";

import {
  CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT,
  CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT,
  normalizeContextChatbotHistory,
} from "./context-chatbot-history";

describe("normalizeContextChatbotHistory", () => {
  it("trims large history entries before sending them to the API", () => {
    const history = normalizeContextChatbotHistory([
      { role: "assistant", content: `  ${"a".repeat(CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT + 200)}  ` },
    ]);

    expect(history).toEqual([
      {
        role: "assistant",
        content: "a".repeat(CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT),
      },
    ]);
  });

  it("drops empty entries and keeps only the newest request history messages", () => {
    const messages = Array.from({ length: CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT + 3 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: index === 1 ? "   " : `message-${index}`,
    }));

    const history = normalizeContextChatbotHistory(messages);

    expect(history).toHaveLength(CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT);
    expect(history[0]?.content).toBe("message-3");
    expect(history.at(-1)?.content).toBe(`message-${CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT + 2}`);
  });
});
