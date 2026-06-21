"use client"

import type { ReactNode } from "react"
import { BookOpen, Database } from "lucide-react"

import { Badge, badgeVariants } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { WorkflowContextCitation } from "@/modules/rag/workflow-context-citations"
import { cn } from "@/lib/utils"

export function WorkflowContextCitations({
  citations,
  className,
}: {
  citations: WorkflowContextCitation[]
  className?: string
}) {
  const contextCount = citations.filter((citation) => citation.sourceType === "project_context").length
  const knowledgeCount = citations.length - contextCount
  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3">
        {citations.length ? (
          <ContextCitationsDialog
            citations={citations}
            contextCount={contextCount}
            knowledgeCount={knowledgeCount}
            trigger={
              <button
                type="button"
                className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Context Used
              </button>
            }
          />
        ) : (
          <div className="text-xs font-medium text-muted-foreground">Context Used</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="gap-1">
          <Database className="size-3" />
          {contextCount} context
        </Badge>
        <Badge variant="secondary" className="gap-1">
          <BookOpen className="size-3" />
          {knowledgeCount} knowledge
        </Badge>
        <ContextCitationBadges citations={citations} />
      </div>
    </div>
  )
}

function ContextCitationsDialog({
  citations,
  contextCount,
  knowledgeCount,
  trigger,
}: {
  citations: WorkflowContextCitation[]
  contextCount: number
  knowledgeCount: number
  trigger: ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        {trigger}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>All Context References</DialogTitle>
          <DialogDescription>
            {citations.length} references used: {contextCount} project context and {knowledgeCount} project knowledge.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(65vh,36rem)] overflow-y-scroll pr-3 [scrollbar-gutter:stable]">
          <div className="space-y-2">
            {citations.map((citation) => (
              <div key={citation.sourceId} className="space-y-2 rounded-lg border bg-muted/25 p-3">
                <Badge variant="outline" className="max-w-full">
                  <span className="truncate">{citationLabel(citation)}</span>
                </Badge>
                <div className="text-sm font-medium">{citation.title}</div>
                {citation.sourceType === "project_context" ? (
                  <div className="text-xs text-muted-foreground">
                    {citation.workItemType} work item {citation.workItemId}
                  </div>
                ) : (
                  <div className="space-y-1 text-xs text-muted-foreground">
                    <div>Category: {citation.category.replaceAll("_", " ")}</div>
                    {citation.sourceWorkItemIds.length ? (
                      <div>Source work items: {citation.sourceWorkItemIds.join(", ")}</div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ContextCitationBadges({ citations }: { citations: WorkflowContextCitation[] }) {
  const visibleCitations = citations.slice(0, 12)
  const hiddenCitations = citations.slice(12)

  return (
    <>
      {visibleCitations.map((citation) => (
        <Tooltip key={citation.sourceId}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                badgeVariants({ variant: "outline" }),
                "max-w-full cursor-help hover:bg-muted hover:text-muted-foreground",
              )}
              aria-label={`Show details for ${citationLabel(citation)}`}
            >
              <span className="truncate">{citationLabel(citation)}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="block max-w-sm whitespace-pre-line text-left">
            {citationTitle(citation)}
          </TooltipContent>
        </Tooltip>
      ))}
      {hiddenCitations.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                badgeVariants({ variant: "secondary" }),
                "cursor-help hover:bg-secondary/80",
              )}
              aria-label={`Show ${hiddenCitations.length} more context references`}
            >
              +{hiddenCitations.length} more
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            sideOffset={6}
            align="start"
            className="block max-h-72 w-[min(28rem,calc(100vw-2rem))] max-w-none overflow-y-auto text-left"
          >
            <div className="mb-2 font-semibold">
              {hiddenCitations.length} more context {hiddenCitations.length === 1 ? "reference" : "references"}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {hiddenCitations.map((citation) => (
                <Badge
                  key={citation.sourceId}
                  variant="outline"
                  className="max-w-full border-background/40 bg-background/10 text-background"
                >
                  <span className="truncate">{citationLabel(citation)}</span>
                </Badge>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}

function citationLabel(citation: WorkflowContextCitation) {
  return citation.sourceType === "project_context"
    ? `${citation.sourceId} ${citation.workItemType}`.trim()
    : citation.sourceId
}

function citationTitle(citation: WorkflowContextCitation) {
  if (citation.sourceType === "project_context") {
    return `${citation.title}\n${citation.workItemType} ${citation.sourceId}`
  }

  const sources = citation.sourceWorkItemIds.length
    ? `\nSource work items: ${citation.sourceWorkItemIds.join(", ")}`
    : ""
  return `${citation.title}\nCategory: ${citation.category}${sources}`
}
