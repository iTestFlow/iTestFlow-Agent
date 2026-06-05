import { Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

export type WorkItemSummary = {
  id: string
  title: string
  workItemType: string
  areaPath?: string
  iterationPath?: string
}

/**
 * Selected Work Item / User Story summary panel (the "#id + type + Area +
 * Iteration" card). Also renders the loading / error / empty states so it is a
 * drop-in for the per-page story-lookup panels.
 *
 * Purely presentational — the container owns the fetch and passes
 * loading/error/story plus an optional `valid` flag (e.g. "is this a
 * requirement-like type?") that switches the tint between success and warning.
 */
export function WorkItemSummaryCard({
  story,
  loading = false,
  error = null,
  valid = true,
  invalidNote,
  emptyText = "Enter a work item ID to load its details here.",
  loadingText = "Loading work item...",
  className,
}: {
  story: WorkItemSummary | null
  loading?: boolean
  error?: string | null
  valid?: boolean
  invalidNote?: string
  emptyText?: string
  loadingText?: string
  className?: string
}) {
  if (loading) {
    return (
      <div className={cn("rounded-md border border-input bg-muted/20 p-3 text-sm text-muted-foreground", className)}>
        <div className="flex items-center gap-2">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          {loadingText}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={cn("rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive", className)}>
        {error}
      </div>
    )
  }

  if (!story) {
    return (
      <div className={cn("rounded-md border border-input bg-muted/10 p-3 text-sm text-muted-foreground", className)}>
        {emptyText}
      </div>
    )
  }

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm text-foreground",
        valid ? "border-success/30 bg-success/10" : "border-warning/40 bg-warning/15",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">#{story.id}</span>
        <Badge variant={valid ? "default" : "secondary"}>{story.workItemType}</Badge>
        {!valid && invalidNote ? <span className="text-xs font-medium text-muted-foreground">{invalidNote}</span> : null}
      </div>
      <div className="mt-2 font-medium">{story.title}</div>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
        {story.areaPath ? <span>Area: {story.areaPath}</span> : null}
        {story.iterationPath ? <span>Iteration: {story.iterationPath}</span> : null}
      </div>
    </div>
  )
}
