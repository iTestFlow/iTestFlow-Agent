"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowUpRight,
  BookOpen,
  Bot,
  Boxes,
  ChevronDown,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  Lightbulb,
  MessageSquarePlus,
  RefreshCw,
  Send,
  Sparkles,
  UserRound,
} from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Callout } from "@/components/qa/callout";
import { CopyButton } from "@/components/workflow/copy-button";
import { cn } from "@/lib/utils";
import { normalizeContextChatbotHistory } from "@/modules/context-chatbot/context-chatbot-history";
import type { WorkflowContextCitation } from "@/modules/rag/workflow-context-citations";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import { postJson } from "@/components/workflow/post-json";

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
    linkedWorkItemCount: number;
    provider: string;
    model: string;
  };
};

type ContextChatbotCitation = WorkflowContextCitation;

type ContextChatbotResponse = {
  answer: string;
  citations: ContextChatbotCitation[];
  retrievedContextCount: number;
  retrievedKnowledgeCount: number;
  linkedWorkItemCount: number;
  provider: string;
  model: string;
};

type ProjectReadinessStatus =
  | "idle"
  | "loading"
  | "ready"
  | "context-only"
  | "knowledge-only"
  | "empty"
  | "unavailable";

type ProjectReadiness = {
  status: ProjectReadinessStatus;
  contextCount: number;
  knowledgeCount: number;
  updatedAt?: string;
};

type ContextStatusResponse = {
  totalCount: number;
  items: Array<{ lastIndexedAt?: string | null }>;
};

type KnowledgeStatusResponse = {
  snapshot: {
    extractedAt?: string | null;
    updatedAt?: string | null;
    knowledgeBase: {
      modules: unknown[];
      businessRules: unknown[];
      stateTransitions: unknown[];
      glossary: unknown[];
      crossDependencies: unknown[];
    };
  } | null;
};

type KnowledgeBaseStatus = NonNullable<KnowledgeStatusResponse["snapshot"]>["knowledgeBase"];

const EMPTY_READINESS: ProjectReadiness = {
  status: "idle",
  contextCount: 0,
  knowledgeCount: 0,
};

const FEATURED_PROMPT = {
  label: "Project overview",
  description: "Understand the project’s purpose, modules, workflows, rules, and dependencies.",
  question: "Give me a concise overview of this project, including its purpose, main modules, key workflows, important business rules, roles, and dependencies. Clearly identify anything the indexed sources do not explain.",
} as const;

const SUGGESTED_PROMPTS = [
  {
    label: "Main business rules",
    question: "What are the main business rules in this project?",
    icon: FileText,
  },
  {
    label: "Key workflows and states",
    question: "Explain the key workflows and state transitions in this project.",
    icon: GitBranch,
  },
  {
    label: "Module dependencies",
    question: "Which modules depend on each other, and what are the important dependencies?",
    icon: Boxes,
  },
  {
    label: "Important terms and roles",
    question: "Summarize the important business terms, actors, and roles in this project.",
    icon: Lightbulb,
  },
] as const;

export function BusinessOwnerAssistantClient({ workspaceRole }: { workspaceRole: WorkspaceRole | null }) {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [readiness, setReadiness] = useState<ProjectReadiness>(EMPTY_READINESS);
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
    setMessages([]);
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      setMessages([]);
      setInput("");
      setError(null);
      setHasUnfinishedWork(false);
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  useEffect(() => {
    if (!scope) {
      setReadiness(EMPTY_READINESS);
      return;
    }

    const controller = new AbortController();
    setReadiness({ ...EMPTY_READINESS, status: "loading" });

    void Promise.all([
      postJson<ContextStatusResponse>(
        "/api/context/status",
        {
          scope,
          page: 1,
          pageSize: 1,
          sortBy: "lastIndexedAt",
          sortDirection: "desc",
          query: "",
        },
        controller.signal,
      ),
      postJson<KnowledgeStatusResponse>(
        "/api/context/knowledge/status",
        { scope },
        controller.signal,
      ),
    ])
      .then(([contextStatus, knowledgeStatus]) => {
        const contextCount = contextStatus.totalCount;
        const knowledgeCount = countKnowledgeItems(knowledgeStatus.snapshot?.knowledgeBase);
        const updatedAt = latestTimestamp([
          contextStatus.items[0]?.lastIndexedAt,
          knowledgeStatus.snapshot?.updatedAt,
          knowledgeStatus.snapshot?.extractedAt,
        ]);
        setReadiness({
          status: readinessStatus(contextCount, knowledgeCount),
          contextCount,
          knowledgeCount,
          updatedAt,
        });
      })
      .catch((statusError) => {
        if (statusError instanceof Error && statusError.name === "AbortError") return;
        setReadiness({ ...EMPTY_READINESS, status: "unavailable" });
      });

    return () => controller.abort();
  }, [scope]);

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
        .filter((message) => message.role === "user" || message.metadata)
        .map((message) => ({
          role: message.role,
          content: message.content,
        })),
    ),
    [messages],
  );

  async function sendMessage(question?: string) {
    const trimmed = (question ?? input).trim();
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
          linkedWorkItemCount: data.linkedWorkItemCount,
          provider: data.provider,
          model: data.model,
        },
      };
      setMessages((current) => [...current, assistantMessage]);
      setHasUnfinishedWork(false);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Business Owner Assistant failed.");
      setHasUnfinishedWork(false);
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
    setMessages([]);
    setError(null);
    setInput("");
    setHasUnfinishedWork(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
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

  const hasChatContent = messages.length > 0 || Boolean(input.trim());

  return (
    <div className="mx-auto grid min-h-[calc(100dvh-11rem)] w-full max-w-6xl grid-rows-[auto_1fr_auto] overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm lg:min-h-[calc(100dvh-9rem)]">
      <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-2">
            <div>
              <div className="truncate text-sm font-semibold">{scope?.azureProjectName ?? "No project selected"}</div>
              <div className="truncate text-xs text-muted-foreground">
                {scope ? organizationLabel(scope.azureOrganizationUrl) : "Select a project from the top bar"}
              </div>
            </div>
            {scope ? <ReadinessSummary readiness={readiness} /> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-end lg:self-auto">
          <ReadinessAction readiness={readiness} />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="h-11" disabled={!hasChatContent}>
                <MessageSquarePlus className="size-4" aria-hidden="true" />
                New chat
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Start a new chat?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will clear the current conversation and any unfinished draft from this session.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="h-11">Keep conversation</AlertDialogCancel>
                <AlertDialogAction className="h-11" onClick={clearChat}>Start new chat</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <ScrollArea className="min-h-0">
        <div
          className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6"
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Assistant conversation"
        >
          {!scope ? (
            <NoProjectState />
          ) : messages.length === 0 ? (
            <AssistantEmptyState
              disabled={loading}
              onSelectPrompt={(question) => void sendMessage(question)}
            />
          ) : messages.map((message) => (
              <ChatBubble
                key={message.id}
                message={message}
                scope={scope}
                promoting={promotingMessageId === message.id}
                canPromoteKnowledge={canPromoteKnowledge}
                onPromote={() => promoteAnswer(message)}
              />
            ))}

          {/* The user message is always appended before `loading` flips true, so the
              parent role="log" announces this indicator as an addition — no nested live region. */}
          {loading ? (
            <div className="flex gap-3">
              <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Bot className="size-4" aria-hidden="true" />
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm">
                <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                Searching indexed context and saved knowledge…
              </div>
            </div>
          ) : null}

          <div ref={messagesEndRef} />
        </div>
      </ScrollArea>

      <div className="border-t border-border bg-card/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur supports-[backdrop-filter]:bg-card/85 sm:px-5">
        <div className="mx-auto w-full max-w-4xl">
          {error ? <Callout tone="error" role="alert" className="mb-3">{error}</Callout> : null}
          <div className="flex items-end gap-2">
            <label htmlFor="business-owner-question" className="sr-only">
              Ask the Business Owner Assistant about this project
            </label>
            <Textarea
              id="business-owner-question"
              ref={textareaRef}
              value={input}
              onChange={(event) => {
                setHasUnfinishedWork(Boolean(event.target.value));
                setInput(event.target.value);
              }}
              onKeyDown={handleKeyDown}
              rows={1}
              maxLength={4000}
              disabled={loading || !scope}
              aria-describedby="business-owner-question-help"
              placeholder={scope ? "Ask a question about this project…" : "Select a project first"}
              className="max-h-36 min-h-11 resize-none py-2.5 text-sm"
            />
            <Button
              className="h-11 min-w-11 gap-2 px-3 sm:px-4"
              onClick={() => void sendMessage()}
              disabled={!input.trim() || loading || !scope}
              aria-label="Ask the Business Owner Assistant"
            >
              <Send className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Ask</span>
            </Button>
          </div>
          <div id="business-owner-question-help" className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {scope ? (
                isMobile
                  ? "Use the Ask button to send"
                  : "Enter to send · Shift+Enter for a new line"
              ) : "Select an Azure DevOps project from the top bar to start chatting."}
            </span>
            {input.length ? <span className="tabular-nums">{input.length}/4000</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantEmptyState({
  disabled,
  onSelectPrompt,
}: {
  disabled: boolean;
  onSelectPrompt: (question: string) => void;
}) {
  return (
    <section className="flex min-h-[28rem] items-center justify-center py-8 text-center" aria-labelledby="assistant-empty-title">
      <div className="w-full max-w-2xl">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/15">
          <Bot className="size-7" aria-hidden="true" />
        </div>
        <h2 id="assistant-empty-title" className="mt-5 text-xl font-semibold tracking-tight text-foreground">
          What would you like to understand?
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          Choose a starting point or ask your own question below.
        </p>
        <Button
          variant="outline"
          className="mt-6 h-auto min-h-20 w-full justify-start gap-3 whitespace-normal border-primary/25 bg-primary/5 p-4 text-left hover:bg-primary/10"
          disabled={disabled}
          onClick={() => onSelectPrompt(FEATURED_PROMPT.question)}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-foreground">{FEATURED_PROMPT.label}</span>
            <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
              {FEATURED_PROMPT.description}
            </span>
          </span>
          <ArrowUpRight className="size-4 shrink-0 text-primary" aria-hidden="true" />
        </Button>
        <div className="mt-3 grid gap-3 text-left sm:grid-cols-2">
          {SUGGESTED_PROMPTS.map((prompt) => {
            const Icon = prompt.icon;
            return (
              <Button
                key={prompt.label}
                variant="outline"
                className="h-auto min-h-16 justify-start gap-3 whitespace-normal p-3 text-left"
                disabled={disabled}
                onClick={() => onSelectPrompt(prompt.question)}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-foreground">{prompt.label}</span>
                  <span className="mt-0.5 block text-xs font-normal leading-5 text-muted-foreground">
                    {prompt.question}
                  </span>
                </span>
                <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              </Button>
            );
          })}
        </div>
        <div className="mx-auto mt-6 flex max-w-xl items-start gap-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2.5 text-left text-xs leading-5 text-muted-foreground">
          <Database className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          <span>Answers use only this project&apos;s indexed work items and saved project knowledge.</span>
        </div>
      </div>
    </section>
  );
}

function NoProjectState() {
  return (
    <section className="flex min-h-[28rem] items-center justify-center py-8 text-center">
      <div className="max-w-md">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Bot className="size-7" aria-hidden="true" />
        </div>
        <h2 className="mt-5 text-lg font-semibold">Select a project to begin</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Choose an Azure DevOps project from the top bar. The assistant will use that project&apos;s indexed context and saved knowledge.
        </p>
      </div>
    </section>
  );
}

function ReadinessSummary({ readiness }: { readiness: ProjectReadiness }) {
  const presentation = readinessPresentation(readiness.status);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <Badge variant="outline" className={cn("gap-1.5", presentation.className)} aria-live="polite">
        {readiness.status === "loading" ? (
          <RefreshCw className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
        )}
        {presentation.label}
      </Badge>
      {readiness.status !== "loading" && readiness.status !== "unavailable" && readiness.status !== "idle" ? (
        <>
          <span>{readiness.contextCount} work {readiness.contextCount === 1 ? "item" : "items"}</span>
          <span aria-hidden="true">·</span>
          <span>{readiness.knowledgeCount} knowledge {readiness.knowledgeCount === 1 ? "item" : "items"}</span>
          {readiness.updatedAt ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatUpdatedAt(readiness.updatedAt)}</span>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ReadinessAction({ readiness }: { readiness: ProjectReadiness }) {
  const labels: Partial<Record<ProjectReadinessStatus, string>> = {
    "context-only": "Build knowledge",
    "knowledge-only": "Reindex context",
    empty: "Open Knowledge Hub",
  };
  const label = labels[readiness.status];
  if (!label) return null;

  return (
    <Button variant="outline" className="h-11" asChild>
      <Link href="/knowledge-hub">
        {label}
        <ArrowUpRight className="size-4" aria-hidden="true" />
      </Link>
    </Button>
  );
}

function ChatBubble({
  message,
  scope,
  promoting,
  canPromoteKnowledge,
  onPromote,
}: {
  message: ChatMessage;
  scope: ActiveProjectScope;
  promoting: boolean;
  canPromoteKnowledge: boolean;
  onPromote: () => void;
}) {
  const isUser = message.role === "user";
  const citations = message.citations ?? [];
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const canPromote = canPromoteKnowledge && !isUser && Boolean(citations.length);

  function openSources(sourceId?: string) {
    setSelectedSourceId(sourceId ?? null);
    setSourceDialogOpen(true);
  }

  return (
    <div className={cn("flex gap-3", isUser && "justify-end")}>
      {!isUser ? (
        <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="size-4" aria-hidden="true" />
        </div>
      ) : null}
      <div className={cn("flex min-w-0 max-w-[min(48rem,88%)] flex-col gap-2", isUser ? "items-end" : "items-start")}>
        <div
          className={cn(
            "min-w-0 rounded-xl border px-3.5 py-2.5 text-sm leading-6",
            isUser
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-card text-card-foreground shadow-sm",
          )}
        >
          <span className="sr-only">{isUser ? "You said:" : "Assistant said:"}</span>
          {isUser ? (
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          ) : (
            <MarkdownMessage
              content={message.content}
              citations={citations}
              onCitation={(citation) => openSources(citation.sourceId)}
            />
          )}
        </div>
        <span className={cn("px-1 text-[0.6875rem] tabular-nums text-muted-foreground", isUser && "self-end")}>
          {formatTime(message.timestamp)}
        </span>

        {!isUser ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            {citations.length ? (
              <Button variant="outline" className="h-11" onClick={() => openSources()}>
                <Database className="size-4" aria-hidden="true" />
                Sources ({citations.length})
              </Button>
            ) : null}
            <CopyButton text={message.content} className="h-11" />
            {canPromote ? (
              <Button variant="outline" className="h-11" onClick={onPromote} disabled={promoting}>
                {promoting ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <BookOpen className="size-4" aria-hidden="true" />}
                Save insight
              </Button>
            ) : null}
          </div>
        ) : null}
        {!isUser && message.metadata ? <ResponseDetails metadata={message.metadata} /> : null}
      </div>
      {isUser ? (
        <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <UserRound className="size-4" aria-hidden="true" />
        </div>
      ) : null}
      {!isUser && citations.length ? (
        <SourceDialog
          open={sourceDialogOpen}
          onOpenChange={setSourceDialogOpen}
          citations={citations}
          selectedSourceId={selectedSourceId}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function MarkdownMessage({
  content,
  citations,
  onCitation,
}: {
  content: string;
  citations: ContextChatbotCitation[];
  onCitation: (citation: ContextChatbotCitation) => void;
}) {
  const renderInline = (value: string) => renderInlineMarkdown(value, { citations, onCitation });
  return <div className="space-y-2 break-words">{renderMarkdownBlocks(content, renderInline)}</div>;
}

type MarkdownTable = {
  headers: string[];
  rows: string[][];
  alignments: Array<"left" | "center" | "right">;
};

function renderMarkdownBlocks(content: string, renderInline: (value: string) => ReactNode = renderInlineMarkdown) {
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
          {renderInline(heading[2])}
        </Tag>,
      );
      index += 1;
      continue;
    }

    const table = parseMarkdownTable(lines, index);
    if (table) {
      blocks.push(<MarkdownTable key={`table-${blocks.length}`} table={table.table} renderInline={renderInline} />);
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
            <li key={itemIndex}>{renderInline(item)}</li>
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
            <li key={itemIndex}>{renderInline(item)}</li>
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
        {renderInline(paragraphLines.join("\n"))}
      </p>,
    );
  }

  return blocks.length ? blocks : content;
}

function MarkdownTable({
  table,
  renderInline,
}: {
  table: MarkdownTable;
  renderInline: (value: string) => ReactNode;
}) {
  return (
    <div className="content-scroll-region rounded-md border border-border">
      <table className="w-full min-w-max border-collapse text-left text-sm">
        <thead className="bg-muted text-foreground">
          <tr>
            {table.headers.map((header, cellIndex) => (
              <th
                key={cellIndex}
                className={cn("border-b-2 border-r border-border px-3 py-2 font-semibold last:border-r-0", tableCellAlignment(table.alignments[cellIndex]))}
              >
                {renderInline(header)}
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
                  {renderInline(row[cellIndex] ?? "")}
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

function ResponseDetails({
  metadata,
}: {
  metadata: NonNullable<ChatMessage["metadata"]>;
}) {
  // Sum of every citation bucket (see buildCitations in context-chatbot.service.ts),
  // so this always equals citations.length / the "Sources (N)" button below.
  const sourceCount = metadata.retrievedContextCount + metadata.retrievedKnowledgeCount + metadata.linkedWorkItemCount;
  return (
    <details className="group w-full text-xs text-muted-foreground">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Database className="size-3.5" aria-hidden="true" />
        Based on {sourceCount} project {sourceCount === 1 ? "source" : "sources"}
        <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
      </summary>
      <dl className="ml-2 grid gap-x-4 gap-y-1 border-l border-border py-2 pl-4 sm:grid-cols-[auto_1fr]">
        <dt>Indexed context</dt>
        <dd className="font-medium text-foreground">{metadata.retrievedContextCount}</dd>
        <dt>Saved knowledge</dt>
        <dd className="font-medium text-foreground">{metadata.retrievedKnowledgeCount}</dd>
        {metadata.linkedWorkItemCount > 0 ? (
          <>
            <dt>Linked work items</dt>
            <dd className="font-medium text-foreground">{metadata.linkedWorkItemCount}</dd>
          </>
        ) : null}
        <dt>Model</dt>
        <dd className="break-all font-medium text-foreground">{metadata.provider} / {metadata.model}</dd>
      </dl>
    </details>
  );
}

function SourceDialog({
  open,
  onOpenChange,
  citations,
  selectedSourceId,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  citations: ContextChatbotCitation[];
  selectedSourceId: string | null;
  scope: ActiveProjectScope;
}) {
  const orderedCitations = selectedSourceId
    ? [
        ...citations.filter((citation) => citation.sourceId === selectedSourceId),
        ...citations.filter((citation) => citation.sourceId !== selectedSourceId),
      ]
    : citations;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{selectedSourceId ? "Source details" : `Sources (${citations.length})`}</DialogTitle>
          <DialogDescription>
            Project evidence used to ground this answer, plus linked work items
            referenced by that saved knowledge so mentions of them are clickable.
            Work-item links open in Azure DevOps.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(65vh,36rem)] space-y-3 overflow-y-auto pr-2">
          {orderedCitations.map((citation) => (
            <SourceCard
              key={citation.sourceId}
              citation={citation}
              scope={scope}
              highlighted={citation.sourceId === selectedSourceId}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceCard({
  citation,
  scope,
  highlighted,
}: {
  citation: ContextChatbotCitation;
  scope: ActiveProjectScope;
  highlighted: boolean;
}) {
  const workItemIds = citation.sourceType === "project_context"
    ? [citation.workItemId]
    : citation.sourceWorkItemIds;

  return (
    <article className={cn("rounded-xl border bg-muted/20 p-4", highlighted && "border-primary/50 bg-primary/5 ring-1 ring-primary/20")}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="max-w-full">
          <span className="truncate">{citation.sourceId}</span>
        </Badge>
        <Badge variant="secondary">
          {citation.sourceType === "project_context" ? citation.workItemType : citation.category.replaceAll("_", " ")}
        </Badge>
      </div>
      <h3 className="mt-3 text-sm font-semibold leading-5 text-foreground">{citation.title}</h3>
      {workItemIds.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {workItemIds.map((workItemId) => (
            <Button key={workItemId} variant="outline" className="h-11" asChild>
              <a
                href={buildAzureWorkItemUrl(scope, workItemId)}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open work item ${workItemId} in Azure DevOps`}
              >
                Work item {workItemId}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </Button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">No source work-item link is available for this knowledge entry.</p>
      )}
    </article>
  );
}

type InlineMarkdownOptions = {
  citations?: ContextChatbotCitation[];
  onCitation?: (citation: ContextChatbotCitation) => void;
};

function renderInlineMarkdown(value: string, options: InlineMarkdownOptions = {}) {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)|\[([^\]]+?)\]|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|`([^`]+?)`|\*([^*\n]+?)\*|_([^_\n]+?)_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push(...renderTextWithCitationButtons(value.slice(lastIndex, match.index), options, `text-${lastIndex}`));
    }
    const [, token, linkText, href, bracketLabel, boldStar, boldUnderscore, code, italicStar, italicUnderscore] = match;
    const key = `${match.index}-${token}`;
    const citation = bracketLabel
      ? options.citations?.find((item) => item.sourceId === bracketLabel)
      : undefined;

    if (linkText && href) {
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">
          {renderInlineMarkdown(linkText, options)}
        </a>,
      );
    } else if (citation && options.onCitation) {
      nodes.push(renderCitationButton(citation, options, key));
    } else if (bracketLabel) {
      const bracketNodes = renderTextWithCitationButtons(bracketLabel, options, `${key}-bracket`);
      if (bracketNodes.some((node) => typeof node !== "string")) {
        nodes.push("[", ...bracketNodes, "]");
      } else {
        nodes.push(token);
      }
    } else if (boldStar || boldUnderscore) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(boldStar ?? boldUnderscore, options)}</strong>);
    } else if (code) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 text-[0.9em] text-foreground">
          {code}
        </code>,
      );
    } else {
      nodes.push(<em key={key}>{renderInlineMarkdown(italicStar ?? italicUnderscore ?? "", options)}</em>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < value.length) {
    nodes.push(...renderTextWithCitationButtons(value.slice(lastIndex), options, `text-${lastIndex}`));
  }
  return nodes.length ? nodes : value;
}

function renderTextWithCitationButtons(value: string, options: InlineMarkdownOptions, keyPrefix: string): ReactNode[] {
  if (!value || !options.onCitation || !options.citations?.length) return value ? [value] : [];
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < value.length) {
    const match = findNextCitation(value, index, options.citations);
    if (!match) break;
    if (match.index > index) nodes.push(value.slice(index, match.index));
    nodes.push(renderCitationButton(match.citation, options, `${keyPrefix}-${match.index}-${match.citation.sourceId}`));
    index = match.index + match.citation.sourceId.length;
  }

  if (index < value.length) nodes.push(value.slice(index));
  return nodes.length ? nodes : [value];
}

function findNextCitation(value: string, startIndex: number, citations: ContextChatbotCitation[]) {
  let best: { citation: ContextChatbotCitation; index: number } | null = null;

  for (const citation of citations) {
    if (!citation.sourceId) continue;
    let index = value.indexOf(citation.sourceId, startIndex);
    while (index !== -1) {
      const endIndex = index + citation.sourceId.length;
      if (isCitationBoundary(value[index - 1]) && isCitationBoundary(value[endIndex])) {
        if (
          !best ||
          index < best.index ||
          (index === best.index && citation.sourceId.length > best.citation.sourceId.length)
        ) {
          best = { citation, index };
        }
        break;
      }
      index = value.indexOf(citation.sourceId, index + 1);
    }
  }

  return best;
}

function isCitationBoundary(char: string | undefined) {
  return !char || !/[A-Za-z0-9:_-]/.test(char);
}

function renderCitationButton(citation: ContextChatbotCitation, options: InlineMarkdownOptions, key: string) {
  return (
    <button
      key={key}
      type="button"
      className="mx-0.5 inline-flex min-h-7 items-center rounded-md border border-primary/20 bg-primary/5 px-1.5 align-baseline text-[0.85em] font-medium leading-6 text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => options.onCitation?.(citation)}
      aria-label={`View source ${citation.sourceId}`}
    >
      {citation.sourceId}
    </button>
  );
}

function countKnowledgeItems(knowledgeBase?: KnowledgeBaseStatus) {
  if (!knowledgeBase) return 0;
  return (
    knowledgeBase.modules.length +
    knowledgeBase.businessRules.length +
    knowledgeBase.stateTransitions.length +
    knowledgeBase.glossary.length +
    knowledgeBase.crossDependencies.length
  );
}

export function readinessStatus(contextCount: number, knowledgeCount: number): ProjectReadinessStatus {
  if (contextCount > 0 && knowledgeCount > 0) return "ready";
  if (contextCount > 0) return "context-only";
  if (knowledgeCount > 0) return "knowledge-only";
  return "empty";
}

function readinessPresentation(status: ProjectReadinessStatus) {
  switch (status) {
    case "loading":
      return { label: "Checking readiness", className: "text-muted-foreground" };
    case "ready":
      return { label: "Ready", className: "border-success/25 bg-success/10 text-success" };
    case "context-only":
      return { label: "Context ready", className: "border-primary/25 bg-primary/10 text-primary" };
    case "knowledge-only":
      return { label: "Knowledge available", className: "border-primary/25 bg-primary/10 text-primary" };
    case "empty":
      return { label: "Setup required", className: "border-warning/35 bg-warning/10 text-warning-foreground" };
    case "unavailable":
      return { label: "Status unavailable", className: "text-muted-foreground" };
    default:
      return { label: "Not checked", className: "text-muted-foreground" };
  }
}

function latestTimestamp(values: Array<string | null | undefined>) {
  return values
    .filter((value): value is string => Boolean(value) && !Number.isNaN(Date.parse(value as string)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

export function organizationLabel(organizationUrl: string) {
  try {
    const url = new URL(organizationUrl);
    const pathOrganization = url.pathname.split("/").filter(Boolean)[0];
    const hostOrganization = url.hostname.endsWith(".visualstudio.com")
      ? url.hostname.split(".")[0]
      : undefined;
    const organization = pathOrganization ?? hostOrganization;
    return organization ? `${decodeURIComponent(organization)} · Azure DevOps` : "Azure DevOps";
  } catch {
    return "Azure DevOps";
  }
}

export function buildAzureWorkItemUrl(scope: ActiveProjectScope, workItemId: string) {
  const organizationUrl = scope.azureOrganizationUrl.replace(/\/+$/, "");
  return `${organizationUrl}/${encodeURIComponent(scope.azureProjectName)}/_workitems/edit/${encodeURIComponent(workItemId)}`;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Update time unavailable";
  return `Updated ${new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date)}`;
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
