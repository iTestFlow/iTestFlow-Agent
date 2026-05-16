"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertTriangle, Bot, Database, RefreshCw, Send, Trash2, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: Date;
  citations?: ContextChatbotCitation[];
  metadata?: {
    retrievedContextCount: number;
    retrievedKnowledgeCount: number;
    provider: string;
    model: string;
  };
  welcome?: boolean;
};

type ContextChatbotCitation = {
  sourceType: "project_context" | "project_knowledge";
  sourceId: string;
  title: string;
  workItemId?: string;
  workItemType?: string;
  category?: string;
  sourceWorkItemIds?: string[];
};

type ContextChatbotResponse = {
  answer: string;
  citations: ContextChatbotCitation[];
  retrievedContextCount: number;
  retrievedKnowledgeCount: number;
  provider: string;
  model: string;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = parseJsonResponse(text, response.ok);
  if (!response.ok) throw new Error(json.error ?? `Request failed: ${response.status}`);
  return json as T;
}

function parseJsonResponse(text: string, ok: boolean) {
  try {
    return JSON.parse(text);
  } catch {
    if (ok) throw new Error("The server returned an invalid JSON response.");
    return { error: "The server returned a non-JSON response. Check the server logs or runtime configuration." };
  }
}

export function ContextChatbotClient() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setScope(readActiveProject());
    setMessages([welcomeMessage()]);
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      setMessages([welcomeMessage()]);
      setError(null);
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth <= 768);
    update();
    let timer: ReturnType<typeof setTimeout>;
    const onResize = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  const history = useMemo(
    () =>
      messages
        .filter((message) => !message.welcome)
        .map((message) => ({
          role: message.role,
          content: message.content,
        }))
        .slice(-10),
    [messages],
  );

  async function sendMessage() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    if (!scope) {
      setError("Select an Azure DevOps project before chatting.");
      return;
    }

    const userMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const data = await postJson<ContextChatbotResponse>("/api/context-chatbot/message", {
        scope,
        message: trimmed,
        history,
      });
      const assistantMessage: ChatMessage = {
        id: createMessageId(),
        role: "assistant",
        content: data.answer,
        timestamp: new Date(),
        citations: data.citations,
        metadata: {
          retrievedContextCount: data.retrievedContextCount,
          retrievedKnowledgeCount: data.retrievedKnowledgeCount,
          provider: data.provider,
          model: data.model,
        },
      };
      setMessages((current) => [...current, assistantMessage]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Context chatbot failed.");
      setMessages((current) => [
        ...current,
        {
          id: createMessageId(),
          role: "assistant",
          content: "I could not complete that request. Check the message above, then try again.",
          timestamp: new Date(),
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function clearChat() {
    setMessages([welcomeMessage()]);
    setError(null);
    setInput("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || isMobile || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  return (
    <div className="grid min-h-[calc(100vh-11rem)] grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{scope?.azureProjectName ?? "No project selected"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {scope ? scope.azureOrganizationUrl : "Select a project from the top bar"}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={clearChat}>
          <Trash2 className="size-4" />
          Clear
        </Button>
      </div>

      <ScrollArea className="min-h-0">
        <div className="space-y-4 p-4">
          {!scope ? (
            <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
              <AlertTriangle className="size-4 shrink-0" />
              Select an Azure DevOps project before chatting.
            </div>
          ) : null}

          {messages.map((message) => (
            <ChatBubble key={message.id} message={message} />
          ))}

          {loading ? (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <RefreshCw className="size-4 animate-spin" />
              </div>
              Searching local context and knowledge...
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="border-t border-border p-3">
        {error ? (
          <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-200">
            {error}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading || !scope}
            placeholder={scope ? "Ask about this project's requirements, rules, workflows, or glossary..." : "Select a project first"}
            className="max-h-36 min-h-10 resize-none rounded-md text-sm"
          />
          <Button
            size="icon-lg"
            onClick={() => void sendMessage()}
            disabled={!input.trim() || loading || !scope}
            aria-label="Send message"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "justify-end")}>
      {!isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="size-4" />
        </div>
      ) : null}
      <div className={cn("max-w-[min(860px,85%)] space-y-2", isUser && "items-end")}>
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm leading-6",
            isUser
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-foreground",
          )}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          <div className={cn("mt-2 text-[11px]", isUser ? "text-primary-foreground/75" : "text-muted-foreground")}>
            {formatTime(message.timestamp)}
          </div>
        </div>

        {!isUser && message.metadata ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="gap-1">
              <Database className="size-3" />
              {message.metadata.retrievedContextCount} context
            </Badge>
            <Badge variant="secondary">{message.metadata.retrievedKnowledgeCount} knowledge</Badge>
            <Badge variant="outline">{message.metadata.provider} / {message.metadata.model}</Badge>
          </div>
        ) : null}

        {!isUser && message.citations?.length ? <CitationList citations={message.citations} /> : null}
      </div>
      {isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <UserRound className="size-4" />
        </div>
      ) : null}
    </div>
  );
}

function CitationList({ citations }: { citations: ContextChatbotCitation[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {citations.slice(0, 12).map((citation) => (
        <Badge key={citation.sourceId} variant="outline" title={citation.title} className="max-w-full">
          <span className="truncate">
            {citation.sourceType === "project_context"
              ? `${citation.sourceId} ${citation.workItemType ?? ""}`.trim()
              : citation.sourceId}
          </span>
        </Badge>
      ))}
      {citations.length > 12 ? <Badge variant="secondary">+{citations.length - 12}</Badge> : null}
    </div>
  );
}

function welcomeMessage(): ChatMessage {
  return {
    id: createMessageId(),
    role: "assistant",
    content: "Hi. Ask me about this project's indexed requirements, business rules, workflows, modules, glossary, or dependencies.",
    timestamp: new Date(),
    welcome: true,
  };
}

function createMessageId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}
