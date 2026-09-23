"use client"

import type { ReactNode, RefObject } from "react"
import { BookOpen, Database, Paperclip } from "lucide-react"

import { Badge, badgeVariants } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  excludedSourceIds = [],
  onExcludedSourceIdsChange,
  editable = false,
  busy = false,
  open,
  onOpenChange,
  restoreFocusRef,
  hideSummary = false,
}: {
  citations: WorkflowContextCitation[]
  className?: string
  /** Source IDs deliberately excluded by the person reviewing the context. */
  excludedSourceIds?: string[]
  onExcludedSourceIdsChange?: (sourceIds: string[]) => void
  /** Enables Remove and Restore controls in a pre-run context review. */
  editable?: boolean
  /** Prevents context changes while a generation or prompt preparation is running. */
  busy?: boolean
  /** Optional controlled dialog state for a pre-run review. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The action that opened a controlled review, used for modal focus restoration. */
  restoreFocusRef?: RefObject<HTMLElement | null>
  /** Hides the result-summary trigger when another control opens the dialog. */
  hideSummary?: boolean
}) {
  const contextCount = citations.filter((citation) => citation.sourceType === "project_context").length
  const documentCount = citations.filter((citation) => citation.sourceType === "uploaded_document").length
  const attachmentCount = citations.filter((citation) => citation.sourceType === "story_attachment").length
  const knowledgeCount = citations.length - contextCount - documentCount - attachmentCount
  const dialog = citations.length || open !== undefined || hideSummary ? (
    <ContextCitationsDialog
      citations={citations}
      contextCount={contextCount}
      knowledgeCount={knowledgeCount}
      documentCount={documentCount}
      attachmentCount={attachmentCount}
      excludedSourceIds={excludedSourceIds}
      onExcludedSourceIdsChange={onExcludedSourceIdsChange}
      editable={editable}
      busy={busy}
      open={open}
      onOpenChange={onOpenChange}
      restoreFocusRef={restoreFocusRef}
      showTrigger={!hideSummary}
      trigger={
        <button
          type="button"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Context Used
        </button>
      }
    />
  ) : null

  if (hideSummary) return dialog

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3">
        {dialog ?? (
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
        {documentCount ? (
          <Badge variant="secondary" className="gap-1">
            <Database className="size-3" />
            {documentCount} document{documentCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {attachmentCount ? (
          <Badge variant="secondary" className="gap-1">
            <Paperclip className="size-3" />
            {attachmentCount} attachment{attachmentCount === 1 ? "" : "s"}
          </Badge>
        ) : null}
        <ContextCitationBadges citations={citations} />
      </div>
    </div>
  )
}

function ContextCitationsDialog({
  citations,
  contextCount,
  knowledgeCount,
  documentCount,
  attachmentCount,
  trigger,
  excludedSourceIds,
  onExcludedSourceIdsChange,
  editable,
  busy,
  open,
  onOpenChange,
  restoreFocusRef,
  showTrigger,
}: {
  citations: WorkflowContextCitation[]
  contextCount: number
  knowledgeCount: number
  documentCount: number
  attachmentCount: number
  trigger: ReactNode
  excludedSourceIds: string[]
  onExcludedSourceIdsChange?: (sourceIds: string[]) => void
  editable: boolean
  busy: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  restoreFocusRef?: RefObject<HTMLElement | null>
  showTrigger: boolean
}) {
  const excludedIds = new Set(excludedSourceIds)
  const excludedCitations = citations.filter((citation) => citationIsExcluded(citation, excludedIds))
  const includedCount = citations.length - excludedCitations.length

  function changeExcludedSourceIds(sourceId: string, excluded: boolean) {
    if (!onExcludedSourceIdsChange) return
    const next = new Set(excludedSourceIds)
    if (excluded) next.add(sourceId)
    else next.delete(sourceId)
    onExcludedSourceIdsChange(Array.from(next))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {showTrigger ? (
        <DialogTrigger asChild>
          {trigger}
        </DialogTrigger>
      ) : null}
      <DialogContent
        className="sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          const opener = restoreFocusRef?.current
          if (!opener || (opener instanceof HTMLButtonElement && opener.disabled)) return
          event.preventDefault()
          opener.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>All Context References</DialogTitle>
          <DialogDescription>
            {editable
              ? `${includedCount} included, ${excludedCitations.length} excluded: ${contextCount} project context, ${knowledgeCount} project knowledge, ${documentCount} documents, and ${attachmentCount} attachments.`
              : `${citations.length} references used: ${contextCount} project context, ${knowledgeCount} project knowledge, ${documentCount} documents, and ${attachmentCount} attachments.`}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[min(65vh,36rem)] overflow-y-scroll pr-3 [scrollbar-gutter:stable]">
          {citations.length ? (
            <div className="space-y-2">
              {citations.map((citation) => {
              const explicitlyExcluded = excludedIds.has(citation.sourceId)
              const dependentSourceId = excludedSourceWorkItemId(citation, excludedIds)
              const excluded = explicitlyExcluded || Boolean(dependentSourceId)
              const automaticallyExcluded = !explicitlyExcluded && Boolean(dependentSourceId)
              return (
                <div
                  key={citation.sourceId}
                  className={cn("space-y-2 rounded-lg border bg-muted/25 p-3", excluded && "border-dashed opacity-70")}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <Badge variant="outline" className="max-w-full">
                      <span className="truncate">{citationLabel(citation)}</span>
                    </Badge>
                    {excluded ? <Badge variant="secondary">Excluded</Badge> : null}
                  </div>
                  <div className="text-sm font-medium">{citation.title}</div>
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Reason: </span>
                    {automaticallyExcluded && dependentSourceId
                      ? `Excluded because source ${dependentSourceId} was removed.`
                      : citationReason(citation)}
                  </div>
                  {citation.sourceType === "project_context" ? (
                    <div className="text-xs text-muted-foreground">
                      {citation.workItemType} work item {citation.workItemId}
                    </div>
                  ) : citation.sourceType === "uploaded_document" ? (
                    <div className="text-xs text-muted-foreground">
                      {citation.documentName}{citation.pageNumber ? ` · page ${citation.pageNumber}` : ""}{citation.section ? ` · ${citation.section}` : ""}
                    </div>
                  ) : citation.sourceType === "story_attachment" ? (
                    <div className="text-xs text-muted-foreground">
                      {citation.fileName}{citation.mimeType ? ` · ${citation.mimeType}` : ""}{citation.visualCount ? ` · ${citation.visualCount} visual${citation.visualCount === 1 ? "" : "s"}` : ""}
                    </div>
                  ) : (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div>Category: {citation.category.replaceAll("_", " ")}</div>
                      {citation.sourceWorkItemIds.length ? (
                        <div>Source work items: {citation.sourceWorkItemIds.join(", ")}</div>
                      ) : null}
                    </div>
                  )}
                  {editable ? (
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant={excluded ? "outline" : "ghost"}
                        size="sm"
                        disabled={busy || automaticallyExcluded}
                        onClick={() => changeExcludedSourceIds(citation.sourceId, !explicitlyExcluded)}
                        aria-label={`${excluded ? "Restore" : "Remove"} ${citation.title} from context`}
                      >
                        {excluded ? "Restore" : "Remove"}
                      </Button>
                    </div>
                  ) : null}
                </div>
                )
              })}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              No optional context is selected for this action.
            </p>
          )}
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
    : citation.sourceType === "uploaded_document"
      ? `${citation.sourceId} Document`
      : citation.sourceType === "story_attachment"
        ? `${citation.sourceId} Attachment`
      : citation.sourceId
}

function citationTitle(citation: WorkflowContextCitation) {
  if (citation.sourceType === "project_context") {
    return `${citation.title}\n${citation.workItemType} ${citation.sourceId}`
  }
  if (citation.sourceType === "uploaded_document") {
    return `${citation.title}\nDocument: ${citation.documentName}${citation.pageNumber ? `\nPage: ${citation.pageNumber}` : ""}${citation.section ? `\nSection: ${citation.section}` : ""}`
  }
  if (citation.sourceType === "story_attachment") {
    return `${citation.title}\nAttachment: ${citation.fileName}${citation.mimeType ? `\nContent type: ${citation.mimeType}` : ""}${citation.visualCount ? `\nVisuals: ${citation.visualCount}` : ""}`
  }

  const sources = citation.sourceWorkItemIds.length
    ? `\nSource work items: ${citation.sourceWorkItemIds.join(", ")}`
    : ""
  return `${citation.title}\nCategory: ${citation.category}${sources}`
}

function citationIsExcluded(citation: WorkflowContextCitation, excludedIds: Set<string>) {
  return excludedIds.has(citation.sourceId) || Boolean(excludedSourceWorkItemId(citation, excludedIds))
}

function excludedSourceWorkItemId(citation: WorkflowContextCitation, excludedIds: Set<string>) {
  if (citation.sourceType !== "project_knowledge") return undefined
  const sourceWorkItemId = citation.sourceWorkItemIds.find((id) => excludedIds.has(`WI:${id}`) || excludedIds.has(id))
  return sourceWorkItemId ? `WI:${sourceWorkItemId}` : undefined
}

function citationReason(citation: WorkflowContextCitation) {
  const reason = (citation as WorkflowContextCitation & { reason?: string }).reason?.trim()
  if (reason) return reason
  if (citation.sourceType === "project_context") return "Related to this story."
  if (citation.sourceType === "project_knowledge") {
    return citation.sourceWorkItemIds.length
      ? `Derived from related story WI:${citation.sourceWorkItemIds[0]}.`
      : "Relevant project knowledge."
  }
  if (citation.sourceType === "uploaded_document") return "Relevant project document content."
  return "Selected attachment for this story."
}
