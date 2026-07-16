"use client"

import { useId, useMemo, useState } from "react"
import type { LucideIcon } from "lucide-react"
import {
  BookOpen,
  Box,
  Check,
  FileText,
  GitBranch,
  LayoutGrid,
  Link2,
  ListChecks,
  Network,
  Quote,
} from "lucide-react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type KnowledgeEvidenceItem = {
  sourceWorkItemId: string
  sourceField: string
  quote: string
}

type KnowledgeEvidenceGroup = {
  sourceField: string
  quote: string
  sourceWorkItemIds: string[]
}

export type KnowledgeDisplayEntry<TCategory extends string = string> = {
  key: string
  highlightIdentity: string
  category: TCategory
  categoryLabel: string
  badge: string
  title: string
  description: string
  evidence: string
  sourceWorkItemIds: string[]
  meta: string[]
  searchText: string
  details?: Array<{ id: string; label: string; value: string }>
  evidenceItems?: KnowledgeEvidenceItem[]
}

export type KnowledgeCategoryVisualKey =
  | "all"
  | "module"
  | "businessRule"
  | "stateTransition"
  | "glossary"
  | "dependency"

const KNOWLEDGE_CATEGORY_ICONS: Record<KnowledgeCategoryVisualKey, LucideIcon> = {
  all: LayoutGrid,
  module: Box,
  businessRule: ListChecks,
  stateTransition: GitBranch,
  glossary: BookOpen,
  dependency: Network,
}

export function KnowledgeCategoryFilterButton({
  label,
  iconKey,
  count,
  active,
  onClick,
}: {
  label: string
  iconKey: KnowledgeCategoryVisualKey
  count: number
  active: boolean
  onClick: () => void
}) {
  const Icon = KNOWLEDGE_CATEGORY_ICONS[iconKey]

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label} ${count}`}
      className={`flex h-11 w-auto max-w-full min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 text-left text-sm font-medium outline-none transition-[background-color,border-color,color,box-shadow] duration-ui focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 lg:h-10 lg:w-full motion-reduce:transition-none ${
        active
          ? "border-primary/20 bg-accent/80 text-accent-foreground shadow-sm"
          : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-accent/50 hover:text-foreground"
      }`}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors duration-ui motion-reduce:transition-none ${
            active
              ? "border-primary/20 bg-primary/10 text-primary"
              : "border-border/60 bg-card/80 text-muted-foreground"
          }`}
        >
          <Icon
            data-knowledge-category-icon={iconKey}
            className="size-3.5"
            aria-hidden="true"
            focusable="false"
          />
        </span>
        <span className="min-w-0 whitespace-nowrap">{label}</span>
      </span>
      <span className="shrink-0 rounded-full border border-border/80 bg-card/80 px-2 py-0.5 text-xs tabular-nums text-muted-foreground shadow-sm">
        {count}
      </span>
    </button>
  )
}

export function KnowledgeEntryCard({
  entry,
  compact,
  highlighted = false,
}: {
  entry: KnowledgeDisplayEntry
  compact?: boolean
  highlighted?: boolean
}) {
  const detailsHeadingId = useId()
  const sourcesHeadingId = useId()
  const evidenceHeadingId = useId()
  const [expanded, setExpanded] = useState(false)
  const [showAllEvidence, setShowAllEvidence] = useState(false)
  const evidenceGroups = useMemo(
    () => groupEvidenceItems(entry.evidenceItems ?? []),
    [entry.evidenceItems],
  )
  const legacyEvidence = evidenceGroups.length === 0 ? entry.evidence.trim() : ""
  const evidenceCount = evidenceGroups.length || (legacyEvidence ? 1 : 0)
  const visibleEvidenceGroups = showAllEvidence ? evidenceGroups : evidenceGroups.slice(0, 3)
  const description = entry.description.trim()
  const summary = description || entry.meta.map((value) => value.trim()).filter(Boolean).join(" \u00b7 ") || summaryFromDetails(entry)
  const sourceLabel = formatCount(entry.sourceWorkItemIds.length, "source", "sources")
  const evidenceLabel = formatCount(evidenceCount, "evidence excerpt", "evidence excerpts")
  const categoryIconKey = knowledgeCategoryVisualKey(entry)
  const CategoryIcon = KNOWLEDGE_CATEGORY_ICONS[categoryIconKey]
  const hasDetails = Boolean(entry.details?.length)
  const hasSources = entry.sourceWorkItemIds.length > 0
  const hasInformation = hasDetails || hasSources
  const hasEvidence = evidenceCount > 0

  return (
    <article
      aria-label={highlighted ? `${entry.title}, updated review result` : undefined}
      className={`knowledge-entry group relative w-full min-w-0 max-w-full overflow-hidden rounded-xl border bg-card shadow-sm transition-[border-color,box-shadow,background-color] duration-ui motion-reduce:transition-none ${
        highlighted
          ? "border-primary/60 bg-primary/5 ring-2 ring-primary/20"
          : expanded
            ? "border-primary/30 shadow-sm ring-1 ring-primary/10"
            : "border-border/80 hover:border-primary/30 hover:shadow-md"
      }`}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-3 left-0 z-10 w-1 rounded-r-full bg-primary opacity-70 transition-opacity duration-ui group-hover:opacity-100 motion-reduce:transition-none"
      />
      <Accordion
        type="single"
        collapsible
        value={expanded ? "details" : ""}
        onValueChange={(value) => {
          const nextExpanded = value === "details"
          setExpanded(nextExpanded)
          if (!nextExpanded) setShowAllEvidence(false)
        }}
        className="w-full min-w-0 max-w-full"
      >
        <AccordionItem
          value="details"
          className="w-full min-w-0 max-w-full rounded-none border-0 bg-transparent [&>h3]:w-full [&>h3]:min-w-0 [&>h3]:max-w-full [&_[data-slot=accordion-content]]:w-full [&_[data-slot=accordion-content]]:min-w-0 [&_[data-slot=accordion-content]]:max-w-full"
        >
          <AccordionTrigger
            aria-label={`${expanded ? "Hide" : "Show"} details for ${entry.title}`}
            className="min-h-[4.5rem] w-full min-w-0 max-w-full cursor-pointer items-start gap-2.5 bg-gradient-to-r from-card via-card to-accent/40 px-3 py-3 hover:bg-muted/20 hover:to-accent/60 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-4 data-[state=open]:to-accent/50 dark:to-accent/20 dark:hover:to-accent/40 dark:data-[state=open]:to-accent/30 motion-reduce:transition-none [&>svg]:mt-0.5 [&>svg]:size-7 [&>svg]:rounded-full [&>svg]:border [&>svg]:border-border/80 [&>svg]:bg-background/80 [&>svg]:p-1.5 [&>svg]:shadow-sm [&>svg]:transition-[transform,background-color,border-color,color] hover:[&>svg]:border-primary/30 hover:[&>svg]:bg-primary/10 hover:[&>svg]:text-primary data-[state=open]:[&>svg]:border-primary/30 data-[state=open]:[&>svg]:bg-primary/10 data-[state=open]:[&>svg]:text-primary motion-reduce:[&>svg]:transition-none"
          >
            <span className="w-full min-w-0 max-w-full flex-1 text-left">
              <span className="knowledge-entry__summary grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-2.5">
                <span className="min-w-0 max-w-full">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge
                      variant="outline"
                      className="max-w-full gap-1.5 rounded-full border-primary/20 bg-accent/70 pl-1.5 font-semibold text-accent-foreground shadow-sm"
                    >
                      <CategoryIcon
                        data-knowledge-category-icon={categoryIconKey}
                        className="size-3.5 text-primary"
                        aria-hidden="true"
                        focusable="false"
                      />
                      {entry.badge}
                    </Badge>
                    {highlighted ? (
                      <Badge className="gap-1 rounded-full">
                        <Check className="size-3.5" aria-hidden="true" />
                        Updated review result
                      </Badge>
                    ) : null}
                    <span className="min-w-0 line-clamp-2 text-balance font-semibold text-foreground [overflow-wrap:anywhere]">
                      {entry.title}
                    </span>
                  </span>
                  {summary ? (
                    <span className="mt-1.5 block min-w-0 max-w-full line-clamp-1 text-sm font-normal text-muted-foreground [overflow-wrap:anywhere]">
                      {summary}
                    </span>
                  ) : null}
                </span>
                <span className="knowledge-entry__metrics flex w-full min-w-0 max-w-full flex-wrap items-center gap-1.5">
                  <Badge
                    variant="outline"
                    className="max-w-full gap-1.5 rounded-full border-border/70 bg-background/60 px-2.5 font-normal text-muted-foreground shadow-sm"
                  >
                    <Link2 className="size-3" aria-hidden="true" />
                    {sourceLabel}
                  </Badge>
                  <Badge
                    variant="outline"
                    className="max-w-full gap-1.5 rounded-full border-border/70 bg-background/60 px-2.5 font-normal text-muted-foreground shadow-sm"
                  >
                    <Quote className="size-3" aria-hidden="true" />
                    {evidenceLabel}
                  </Badge>
                  <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-xs font-semibold text-accent-foreground transition-colors duration-ui group-hover:bg-accent/80 motion-reduce:transition-none">
                    Details
                  </span>
                </span>
              </span>
            </span>
          </AccordionTrigger>

          {hasInformation || hasEvidence ? (
            <AccordionContent className="w-full min-w-0 max-w-full bg-gradient-to-br from-muted/30 via-background to-accent/30 p-3 sm:p-4 dark:from-muted/20 dark:to-accent/20">
              <div className="knowledge-entry__expanded grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-3">
                {hasInformation ? (
                  <section
                    aria-labelledby={hasDetails ? detailsHeadingId : sourcesHeadingId}
                    className={`min-w-0 max-w-full overflow-hidden rounded-lg border border-border/80 bg-card/90 shadow-sm ${
                      hasEvidence ? "" : "knowledge-entry__panel--full"
                    }`}
                  >
                    {hasDetails ? (
                      <>
                        <div className="flex min-w-0 items-center gap-2.5 px-3 py-3 sm:px-4">
                          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/10 text-primary">
                            <FileText className="size-4" aria-hidden="true" />
                          </span>
                          <h4 id={detailsHeadingId} className="min-w-0 text-sm font-semibold text-foreground">
                            Knowledge details
                          </h4>
                        </div>
                        <dl className="min-w-0 max-w-full divide-y divide-border/70 border-t border-border/70 px-3 sm:px-4">
                          {entry.details?.map((detail) => (
                            <div
                              key={detail.id}
                              className="grid min-w-0 max-w-full gap-1 py-2.5 sm:grid-cols-[128px_minmax(0,1fr)] sm:gap-3"
                            >
                              <dt className="text-xs font-semibold text-muted-foreground [overflow-wrap:anywhere]">
                                {detail.label}
                              </dt>
                              <dd className="min-w-0 max-w-full whitespace-pre-wrap text-sm leading-6 text-foreground [overflow-wrap:anywhere]">
                                {detail.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </>
                    ) : null}

                    {hasSources ? (
                      <div className={`min-w-0 max-w-full px-3 py-3 sm:px-4 ${hasDetails ? "border-t border-border/70" : ""}`}>
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/10 text-primary">
                            <Link2 className="size-4" aria-hidden="true" />
                          </span>
                          <h4 id={sourcesHeadingId} className="min-w-0 text-sm font-semibold text-foreground">
                            Source work items
                          </h4>
                        </div>
                        <SourceWorkItemBadges
                          className="mt-3 w-full max-w-full"
                          ids={entry.sourceWorkItemIds}
                          maxVisible={compact ? 6 : 10}
                        />
                      </div>
                    ) : null}
                  </section>
                ) : null}

                {hasEvidence ? (
                  <section
                    aria-labelledby={evidenceHeadingId}
                    className={`min-w-0 max-w-full overflow-hidden rounded-lg border border-border/80 bg-card/90 shadow-sm ${
                      hasInformation ? "" : "knowledge-entry__panel--full"
                    }`}
                  >
                    <div className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-4">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-primary/15 bg-primary/10 text-primary">
                          <Quote className="size-4" aria-hidden="true" />
                        </span>
                        <h4 id={evidenceHeadingId} className="min-w-0 text-sm font-semibold text-foreground">
                          Verified source evidence
                        </h4>
                      </div>
                      <Badge
                        variant="outline"
                        className="shrink-0 rounded-full border-border/80 bg-background/70 font-normal tabular-nums text-muted-foreground"
                      >
                        {evidenceLabel}
                      </Badge>
                    </div>

                    {evidenceGroups.length ? (
                      <div className="min-w-0 max-w-full divide-y divide-border/70 border-t border-border/70">
                        {visibleEvidenceGroups.map((evidence) => (
                          <div
                            key={`${evidence.sourceField}:${evidence.quote}`}
                            className="min-w-0 max-w-full px-3 py-3 sm:px-4"
                          >
                            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                              <Badge
                                variant="secondary"
                                className="h-auto max-w-full whitespace-normal py-1 font-normal [overflow-wrap:anywhere]"
                              >
                                {evidence.sourceField}
                              </Badge>
                              <SourceWorkItemBadges ids={evidence.sourceWorkItemIds} maxVisible={8} />
                            </div>
                            <blockquote className="mt-2.5 min-w-0 max-w-full whitespace-pre-wrap rounded-md border-l-2 border-primary/60 bg-accent/35 px-3 py-2 text-sm italic leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                              {evidence.quote}
                            </blockquote>
                          </div>
                        ))}

                        {evidenceGroups.length > 3 ? (
                          <div className="flex min-w-0 max-w-full justify-end px-3 py-2 sm:px-4">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="min-h-11 w-full px-3 sm:w-auto lg:min-h-9"
                              onClick={() => setShowAllEvidence((current) => !current)}
                            >
                              {showAllEvidence
                                ? "Show fewer evidence excerpts"
                                : `Show all ${evidenceGroups.length} evidence excerpts`}
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="min-w-0 max-w-full border-t border-border/70 px-3 py-3 sm:px-4">
                        <blockquote className="min-w-0 max-w-full whitespace-pre-wrap rounded-md border-l-2 border-primary/60 bg-accent/35 px-3 py-2 text-sm italic leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                          {legacyEvidence}
                        </blockquote>
                      </div>
                    )}
                  </section>
                ) : null}
              </div>
            </AccordionContent>
          ) : null}
        </AccordionItem>
      </Accordion>
    </article>
  )
}

function SourceWorkItemBadges({
  ids,
  maxVisible,
  className = "",
}: {
  ids: string[]
  maxVisible: number
  className?: string
}) {
  const visibleIds = ids.slice(0, maxVisible)
  const hiddenIds = ids.slice(maxVisible)

  return (
    <div role="group" aria-label="Source work item IDs" className={`flex w-full min-w-0 max-w-full flex-wrap gap-1 ${className}`}>
      {visibleIds.map((id) => (
        <Badge
          key={id}
          variant="outline"
          className="h-auto max-w-full whitespace-normal font-mono text-xs tabular-nums [overflow-wrap:anywhere]"
        >
          #{id}
        </Badge>
      ))}
      {hiddenIds.length ? (
        <Badge
          variant="outline"
          className="h-auto max-w-full whitespace-normal font-mono text-xs tabular-nums text-muted-foreground [overflow-wrap:anywhere]"
          aria-label={`${hiddenIds.length} more source work items: ${hiddenIds.map((id) => `#${id}`).join(", ")}`}
          title={hiddenIds.map((id) => `#${id}`).join(", ")}
        >
          +{hiddenIds.length}
        </Badge>
      ) : null}
    </div>
  )
}

function groupEvidenceItems(items: KnowledgeEvidenceItem[]): KnowledgeEvidenceGroup[] {
  const groups = new Map<string, KnowledgeEvidenceGroup>()

  for (const item of items) {
    const sourceField = item.sourceField.trim()
    const quote = item.quote.trim()
    if (!quote) continue
    const key = `${sourceField}\u0000${quote}`
    const existing = groups.get(key)
    if (existing) {
      if (!existing.sourceWorkItemIds.includes(item.sourceWorkItemId)) {
        existing.sourceWorkItemIds.push(item.sourceWorkItemId)
      }
      continue
    }
    groups.set(key, {
      sourceField,
      quote,
      sourceWorkItemIds: [item.sourceWorkItemId],
    })
  }

  return Array.from(groups.values())
}

function summaryFromDetails(entry: KnowledgeDisplayEntry) {
  const normalizedTitle = entry.title.trim()
  const detail = entry.details?.find((item) => {
    const value = item.value.trim()
    return value && value !== normalizedTitle && !["id", "name", "term", "rule"].includes(item.id)
  })
  return detail?.value.trim() ?? ""
}

function formatCount(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`
}

function knowledgeCategoryVisualKey(entry: KnowledgeDisplayEntry): KnowledgeCategoryVisualKey {
  const category = `${entry.category} ${entry.categoryLabel} ${entry.badge}`.toLowerCase()
  if (category.includes("business") && category.includes("rule")) return "businessRule"
  if (category.includes("transition")) return "stateTransition"
  if (category.includes("glossary")) return "glossary"
  if (category.includes("depend")) return "dependency"
  return "module"
}
