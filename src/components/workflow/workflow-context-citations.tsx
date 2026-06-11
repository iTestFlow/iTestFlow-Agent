"use client"

import { BookOpen, Database } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
      <div className="text-xs font-medium text-muted-foreground">Context Used</div>
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

export function ContextCitationBadges({ citations }: { citations: WorkflowContextCitation[] }) {
  const visibleCitations = citations.slice(0, 12)

  return (
    <>
      {visibleCitations.map((citation) => (
        <Badge
          key={citation.sourceId}
          variant="outline"
          title={citationTitle(citation)}
          className="max-w-full"
        >
          <span className="truncate">
            {citation.sourceType === "project_context"
              ? `${citation.sourceId} ${citation.workItemType}`.trim()
              : citation.sourceId}
          </span>
        </Badge>
      ))}
      {citations.length > 12 ? <Badge variant="secondary">+{citations.length - 12}</Badge> : null}
    </>
  )
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
