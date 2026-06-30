"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BookOpen, Bot, Database, RefreshCw, Send, Trash2, UserRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Callout } from "@/components/qa/callout";
import { ContextCitationBadges } from "@/components/workflow/workflow-context-citations";
import { cn } from "@/lib/utils";
import { normalizeContextChatbotHistory } from "@/modules/context-chatbot/context-chatbot-history";
import type { WorkflowContextCitation } from "@/modules/rag/workflow-context-citations";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type ChatRole = "user" | "assistant";
type WorkspaceRole = "owner" | "admin" | "member";

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

type ContextChatbotCitation = WorkflowContextCitation;

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

export function BusinessOwnerAssistantClient({ workspaceRole }: { workspaceRole: WorkspaceRole | null }) {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [promotingMessageId, setPromotingMessageId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({ dirty: hasUnfinishedWork, busy: loading || Boolean(promotingMessageId) });
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canPromoteKnowledge = workspaceRole === "owner" || workspaceRole === "admin";

  useEffect(() => {
    setScope(readActiveProject());
    setMessages([welcomeMessage()]);
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      setMessages([welcomeMessage()]);
      setError(null);
      setHasUnfinishedWork(false);
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
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    messagesEndRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  const history = useMemo(
    () => normalizeContextChatbotHistory(
      messages
        .filter((message) => !message.welcome && (message.role === "user" || message.metadata))
        .map((message) => ({
          role: message.role,
          content: message.content,
        })),
    ),
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
    setHasUnfinishedWork(true);
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
      setHasUnfinishedWork(false);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Business Owner Assistant failed.");
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
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function clearChat() {
    setMessages([welcomeMessage()]);
    setError(null);
    setInput("");
    setHasUnfinishedWork(false);
  }

  async function promoteAnswer(message: ChatMessage) {
    if (!canPromoteKnowledge || !scope || !message.citations?.length) return;
    setPromotingMessageId(message.id);
    setError(null);
    try {
      await postJson("/api/context/knowledge/promote", {
        scope,
        answer: message.content,
        citations: message.citations,
      });
      setMessages((current) =>
        current.map((item) =>
          item.id === message.id
            ? {
                ...item,
                content: `${item.content}\n\n_Saved as candidate project knowledge._`,
              }
            : item,
        ),
      );
    } catch (promoteError) {
      setError(promoteError instanceof Error ? promoteError.message : "Could not save this answer as candidate knowledge.");
    } finally {
      setPromotingMessageId(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || isMobile || event.shiftKey) return;
    event.preventDefault();
    void sendMessage();
  }

  return (
    <div className="grid min-h-[calc(100dvh-11rem)] grid-rows-[auto_1fr_auto] overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm lg:min-h-[calc(100dvh-9rem)]">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{scope?.azureProjectName ?? "No project selected"}</div>
            <div className="truncate text-xs text-muted-foreground">
              {scope ? scope.azureOrganizationUrl : "Select a project from the top bar"}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={clearChat}>
          <Trash2 className="size-4" aria-hidden="true" />
          Clear
        </Button>
      </div>

      <ScrollArea className="min-h-0">
        <div className="space-y-6 p-4" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Assistant conversation">
          {!scope ? (
            <Callout tone="warning">Select an Azure DevOps project before chatting.</Callout>
          ) : null}

          {messages.map((message) => (
            <ChatBubble
              key={message.id}
              message={message}
              promoting={promotingMessageId === message.id}
              canPromoteKnowledge={canPromoteKnowledge}
              onPromote={() => promoteAnswer(message)}
            />
          ))}

          {loading ? (
            <div className="flex gap-3" role="status" aria-live="polite">
              <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bot className="size-4" aria-hidden="true" />
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Searching local context and knowledge…
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="border-t border-border p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        {error ? <Callout tone="error" role="alert" className="mb-3">{error}</Callout> : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              setHasUnfinishedWork(true);
              setInput(event.target.value);
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={loading || !scope}
            aria-label="Ask the Business Owner Assistant about this project"
            placeholder={scope ? "Ask about this project's requirements, rules, workflows, or glossary..." : "Select a project first"}
            className="max-h-36 min-h-10 resize-none text-sm"
          />
          <Button
            size="icon-lg"
            onClick={() => void sendMessage()}
            disabled={!input.trim() || loading || !scope}
            aria-label="Send message"
          >
            <Send className="size-4" aria-hidden="true" />
          </Button>
        </div>
        {!scope ? (
          <p className="mt-2 text-xs text-muted-foreground">Select an Azure DevOps project from the top bar to start chatting.</p>
        ) : null}
      </div>
    </div>
  );
}

function ChatBubble({
  message,
  promoting,
  canPromoteKnowledge,
  onPromote,
}: {
  message: ChatMessage;
  promoting: boolean;
  canPromoteKnowledge: boolean;
  onPromote: () => void;
}) {
  const isUser = message.role === "user";
  const isWelcome = Boolean(message.welcome);
  const canPromote = canPromoteKnowledge && !isUser && !message.welcome && Boolean(message.citations?.length);
  return (
    <div className={cn("flex gap-3", isUser && "justify-end")}>
      {!isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="size-4" aria-hidden="true" />
        </div>
      ) : null}
      <div className={cn("flex max-w-[min(860px,85%)] flex-col gap-2", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-lg border px-3 py-2 text-sm leading-6",
            isWelcome
              ? "border-dashed border-border bg-muted/30 text-muted-foreground"
              : isUser
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-card-foreground shadow-sm",
          )}
        >
          <span className="sr-only">{isUser ? "You said:" : "Assistant said:"}</span>
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <MarkdownMessage content={message.content} />
          )}
        </div>
        {!isWelcome ? (
          <span className={cn("px-1 text-[0.6875rem] tabular-nums text-muted-foreground", isUser && "self-end")}>
            {formatTime(message.timestamp)}
          </span>
        ) : null}

        {!isUser && message.metadata ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" className="gap-1">
              <Database className="size-3" aria-hidden="true" />
              {message.metadata.retrievedContextCount} context
            </Badge>
            <Badge variant="secondary">{message.metadata.retrievedKnowledgeCount} knowledge</Badge>
            <Badge variant="outline" className="max-w-full min-w-0"><span className="truncate">{message.metadata.provider} / {message.metadata.model}</span></Badge>
          </div>
        ) : null}

        {!isUser && message.citations?.length ? <CitationList citations={message.citations} /> : null}
        {canPromote ? (
          <Button variant="outline" size="sm" onClick={onPromote} disabled={promoting}>
            {promoting ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <BookOpen className="size-4" aria-hidden="true" />}
            Save insight
          </Button>
        ) : null}
      </div>
      {isUser ? (
        <div className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <UserRound className="size-4" aria-hidden="true" />
        </div>
      ) : null}
    </div>
  );
}

function MarkdownMessage({ content }: { content: string }) {
  return <div className="space-y-2 break-words">{renderMarkdownBlocks(content)}</div>;
}

type MarkdownTable = {
  headers: string[];
  rows: string[][];
  alignments: Array<"left" | "center" | "right">;
};

function renderMarkdownBlocks(content: string) {
  const blocks: ReactNode[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre key={`code-${blocks.length}`} className="overflow-x-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-5 text-foreground">
          {language ? <div className="mb-2 text-xs font-medium uppercase text-muted-foreground/70">{language}</div> : null}
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = level === 1 ? "h3" : level === 2 ? "h4" : "h5";
      const headingClass = level === 1 ? "text-base font-semibold" : level === 2 ? "text-sm font-semibold" : "text-sm font-medium text-muted-foreground";
      blocks.push(
        <Tag key={`heading-${blocks.length}`} className={cn("mt-3 text-foreground first:mt-0", headingClass)}>
          {renderInlineMarkdown(heading[2])}
        </Tag>,
      );
      index += 1;
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(<MarkdownTable key={`table-${blocks.length}`} table={table.table} />);
      index = table.nextIndex;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="list-disc space-y-1 pl-5">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`} className="list-decimal space-y-1 pl-5">
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    const paragraphLines = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith("```") &&
      !/^(#{1,3})\s+/.test(lines[index]) &&
      !parseMarkdownTable(lines, index) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={`p-${blocks.length}`} className="whitespace-pre-wrap">
        {renderInlineMarkdown(paragraphLines.join("\n"))}
      </p>,
    );
  }

  return blocks.length ? blocks : content;
}

function MarkdownTable({ table }: { table: MarkdownTable }) {
  return (
    <div className="dashboard-scroll-region rounded-md border border-border">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead className="bg-muted text-foreground">
          <tr>
            {table.headers.map((header, cellIndex) => (
              <th
                key={cellIndex}
                className={cn("border-b-2 border-r border-border px-3 py-2 font-semibold last:border-r-0", tableCellAlignment(table.alignments[cellIndex]))}
              >
                {renderInlineMarkdown(header)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-background even:bg-muted/25">
              {table.headers.map((_, cellIndex) => (
                <td
                  key={cellIndex}
                  className={cn("max-w-[min(20rem,70vw)] whitespace-normal break-words border-r border-t border-border px-3 py-2 align-top last:border-r-0", tableCellAlignment(table.alignments[cellIndex]))}
                >
                  {renderInlineMarkdown(row[cellIndex] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseMarkdownTable(lines: string[], startIndex: number): { table: MarkdownTable; nextIndex: number } | null {
  if (startIndex + 1 >= lines.length) return null;
  const header = splitMarkdownTableRow(lines[startIndex]);
  const delimiter = splitMarkdownTableRow(lines[startIndex + 1]);
  if (header.length < 2 || delimiter.length !== header.length || !delimiter.every(isMarkdownTableDelimiterCell)) {
    return null;
  }

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && isMarkdownTableRow(lines[index])) {
    const row = splitMarkdownTableRow(lines[index]);
    if (!row.length) break;
    rows.push(row);
    index += 1;
  }

  return {
    table: {
      headers: header,
      rows,
      alignments: delimiter.map(parseMarkdownTableAlignment),
    },
    nextIndex: index,
  };
}

function isMarkdownTableRow(line: string) {
  return line.includes("|") && splitMarkdownTableRow(line).length >= 2;
}

function splitMarkdownTableRow(line: string) {
  const trimmed = line.trim();
  const withoutOuterPipes = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";

  for (let index = 0; index < withoutOuterPipes.length; index += 1) {
    const char = withoutOuterPipes[index];
    const nextChar = withoutOuterPipes[index + 1];
    if (char === "\\" && nextChar === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (char === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function isMarkdownTableDelimiterCell(cell: string) {
  return /^:?-{3,}:?$/.test(cell.trim());
}

function parseMarkdownTableAlignment(cell: string) {
  const trimmed = cell.trim();
  if (trimmed.startsWith(":") && trimmed.endsWith(":")) return "center";
  if (trimmed.endsWith(":")) return "right";
  return "left";
}

function tableCellAlignment(alignment: "left" | "center" | "right" | undefined) {
  if (alignment === "center") return "text-center";
  if (alignment === "right") return "text-right";
  return "text-left";
}

function renderInlineMarkdown(value: string) {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|`([^`]+?)`|\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)|\*([^*\n]+?)\*|_([^_\n]+?)_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value))) {
    if (match.index > lastIndex) nodes.push(value.slice(lastIndex, match.index));
    const [, token, boldStar, boldUnderscore, code, linkText, href, italicStar, italicUnderscore] = match;
    const key = `${match.index}-${token}`;

    if (boldStar || boldUnderscore) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(boldStar ?? boldUnderscore)}</strong>);
    } else if (code) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em] text-foreground">
          {code}
        </code>,
      );
    } else if (linkText && href) {
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {renderInlineMarkdown(linkText)}
        </a>,
      );
    } else {
      nodes.push(<em key={key}>{renderInlineMarkdown(italicStar ?? italicUnderscore ?? "")}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return nodes.length ? nodes : value;
}

function CitationList({ citations }: { citations: ContextChatbotCitation[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <ContextCitationBadges citations={citations} />
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
