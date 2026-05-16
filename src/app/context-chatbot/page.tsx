import { ContentShell } from "@/components/layout/content-shell";
import { ContextChatbotClient } from "./context-chatbot-client";

export default function ContextChatbotPage() {
  return (
    <ContentShell
      title="Context Chatbot"
      description="Ask questions grounded in the selected project's indexed context and saved knowledge hub."
    >
      <ContextChatbotClient />
    </ContentShell>
  );
}
