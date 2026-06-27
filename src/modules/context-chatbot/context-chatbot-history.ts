export const CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT = 10;
export const CONTEXT_CHATBOT_PROMPT_HISTORY_LIMIT = 8;
export const CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT = 1200;

export type ContextChatbotHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export function normalizeContextChatbotHistory(
  history: ContextChatbotHistoryMessage[],
  limit = CONTEXT_CHATBOT_HISTORY_REQUEST_LIMIT,
) {
  return history
    .map((message) => ({
      role: message.role,
      content: trimHistoryContent(message.content),
    }))
    .filter((message) => message.content)
    .slice(-limit);
}

export function trimHistoryContent(content: string) {
  return content.trim().slice(0, CONTEXT_CHATBOT_HISTORY_CONTENT_LIMIT);
}
