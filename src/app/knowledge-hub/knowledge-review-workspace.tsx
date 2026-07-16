"use client"

import { useMemo, useState } from "react"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  GitMerge,
  Loader2,
  RotateCcw,
  Search,
  ShieldCheck,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema"
import type {
  ProjectKnowledgeDraftBlocker,
  ProjectKnowledgeReviewContext,
  ProjectKnowledgeReviewSummary,
} from "@/modules/rag/project-knowledge-review.contracts"

type Props = {
  draftId: string
  status: string
  blockers: ProjectKnowledgeDraftBlocker[]
  reviewSummary: ProjectKnowledgeReviewSummary
  regenerateRequired?: boolean
  proposedKnowledge: ProjectKnowledgeBase | null
  busy: boolean
  onLoadReviewContext: () => Promise<ProjectKnowledgeReviewContext>
  onResolve: (knowledgeBase: ProjectKnowledgeBase) => Promise<void>
  onRebase: () => Promise<void>
  onRegenerate: () => Promise<void>
}

/**
 * Compatibility renderer for one release. The active v4 flow lives in
 * KnowledgeBuildV4 and submits compact conflict decisions. This component
 * intentionally exposes no evidence editor, source selector, re-check, or
 * rebase action if an older client state reaches it.
 */
export function KnowledgeReviewWorkspace(props: Props) {
  const conflicts = props.blockers.filter((blocker) => blocker.type === "hard_conflict")
  if (!conflicts.length) {
    return (
      <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 p-4 text-sm">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden="true" />
        <div>
          <div className="font-semibold text-foreground">Draft checks passed</div>
          <p className="mt-1 text-xs text-muted-foreground">Publication still requires one explicit Publish action.</p>
        </div>
      </div>
    )
  }

  return (
    <div role="status" className="flex items-start gap-3 rounded-md border border-warning/30 bg-warning/10 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning-foreground" aria-hidden="true" />
      <div>
        <div className="font-semibold text-foreground">{conflicts.length} knowledge {conflicts.length === 1 ? "conflict" : "conflicts"}</div>
        <p className="mt-1 text-xs text-muted-foreground">Reload the v4 conflict-only workspace to choose or combine supported versions.</p>
      </div>
    </div>
  )
}

export type CompactConflictParticipant = {
  participantId: string
  entryKey: string
  fields: Record<string, unknown>
  evidence: Array<{ sourceField: string; quote: string; sourceWorkItemId: string }>
}

export type CompactKnowledgeConflict = {
  conflictId: string
  identityKey: string
  subject: string
  affectedCategory: string
  conflictType: string
  participants: CompactConflictParticipant[]
}

export type CompactConflictPage = {
  draftVersion: string
  counts: { total: number; resolved: number; remaining: number }
  page: number
  pageSize: number
  pageCount: number
  conflicts: CompactKnowledgeConflict[]
}

export type CompactConflictDecision =
  | { conflictId: string; action: "keep"; participantId: string }
  | { conflictId: string; action: "combine"; fieldParticipants: Record<string, string> }

export function KnowledgeConflictReview({
  page,
  loading,
  decisions,
  active,
  onDecision,
  onPage,
  onReset,
  onApply,
}: {
  page: CompactConflictPage | null
  loading: boolean
  decisions: Record<string, CompactConflictDecision>
  active: boolean
  onDecision: (decision: CompactConflictDecision) => void
  onPage: (page: number) => void
  onReset: () => void
  onApply: () => void
}) {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState("all")
  const selectedCount = Object.keys(decisions).length
  const totalCount = page?.counts.total ?? 0
  const allSelected = Boolean(page) && totalCount > 0 && selectedCount === totalCount
  const normalizedQuery = query.trim().toLowerCase()
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const conflict of page?.conflicts ?? []) {
      counts.set(conflict.affectedCategory, (counts.get(conflict.affectedCategory) ?? 0) + 1)
    }
    return Array.from(counts.entries())
  }, [page])
  const visibleConflicts = (page?.conflicts ?? []).filter((conflict) => {
    if (category !== "all" && conflict.affectedCategory !== category) return false
    if (!normalizedQuery) return true
    return [
      conflict.subject,
      conflict.conflictType,
      conflict.affectedCategory,
      ...conflict.participants.flatMap((participant) => [
        participant.entryKey,
        JSON.stringify(participant.fields),
        ...participant.evidence.flatMap((evidence) => [evidence.sourceWorkItemId, evidence.sourceField, evidence.quote]),
      ]),
    ].join(" ").toLowerCase().includes(normalizedQuery)
  })

  return (
    <section className="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4" aria-labelledby="knowledge-conflicts-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <h2 id="knowledge-conflicts-title" className="text-sm font-semibold text-destructive">
              {totalCount
                ? `${totalCount} knowledge ${totalCount === 1 ? "conflict needs" : "conflicts need"} review before publishing`
                : "Knowledge conflicts need review before publishing"}
            </h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Compare the supported versions and their evidence. Keep one version or review and combine supported fields.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <Badge variant="destructive" className="w-fit tabular-nums">{page?.counts.remaining ?? totalCount} unresolved</Badge>
          {selectedCount > 0 ? (
            <Badge variant="outline" className="w-fit gap-1 tabular-nums">
              <Check className="size-3.5" aria-hidden="true" />
              {selectedCount} decided locally — apply when complete
            </Badge>
          ) : null}
        </div>
      </div>

      {page && page.conflicts.length ? (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {categoryCounts.length > 1 ? (
            <div role="group" aria-label="Filter conflicts on this page by category" className="flex flex-wrap gap-2">
              <ConflictFilterButton label="All" count={page.conflicts.length} active={category === "all"} onClick={() => setCategory("all")} />
              {categoryCounts.map(([key, count]) => (
                <ConflictFilterButton
                  key={key}
                  label={conflictCategoryLabel(key)}
                  count={count}
                  active={category === key}
                  onClick={() => setCategory(key)}
                />
              ))}
            </div>
          ) : <div />}
          <div className="relative w-full lg:w-[360px]">
            <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" />
            <Input
              className="h-11 pl-9"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search conflicts on this page"
              aria-label="Search knowledge conflicts on this page"
            />
          </div>
        </div>
      ) : null}

      {loading ? (
        <div role="status" className="flex min-h-32 items-center justify-center gap-2 rounded-lg border border-border bg-card text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading conflicts…
        </div>
      ) : visibleConflicts.length ? (
        <div className="space-y-3" aria-label="Unresolved knowledge conflicts">
          {visibleConflicts.map((conflict) => {
            const pageIndex = page?.conflicts.findIndex((candidate) => candidate.conflictId === conflict.conflictId) ?? 0
            return (
              <KnowledgeConflictCard
                key={conflict.conflictId}
                conflict={conflict}
                ordinal={((page?.page ?? 1) - 1) * (page?.pageSize ?? 50) + pageIndex + 1}
                decision={decisions[conflict.conflictId]}
                disabled={active}
                onDecision={onDecision}
              />
            )
          })}
        </div>
      ) : (
        <div className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">
          No unresolved conflicts match the current page filters.
        </div>
      )}

      {page && page.pageCount > 1 ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            <span>Showing {(page.page - 1) * page.pageSize + 1}-{Math.min(page.page * page.pageSize, page.counts.total)} of {page.counts.total}</span>
            <span>Page {page.page} of {page.pageCount}</span>
          </div>
          <div className="flex gap-2">
            <Button className="min-h-11" size="sm" variant="outline" onClick={() => onPage(page.page - 1)} disabled={loading || page.page <= 1}>
              <ChevronLeft className="size-4" aria-hidden="true" /> Previous
            </Button>
            <Button className="min-h-11" size="sm" variant="outline" onClick={() => onPage(page.page + 1)} disabled={loading || page.page >= page.pageCount}>
              Next <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-2 border-t border-border pt-4">
        {!allSelected ? (
          <p id="knowledge-conflict-action-help" className="text-right text-xs text-muted-foreground">
            Resolve every conflict before applying the decisions.
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button className="min-h-11" size="sm" variant="outline" onClick={onReset} disabled={active || selectedCount === 0}>
            <RotateCcw className="size-4" aria-hidden="true" /> Discard review changes
          </Button>
          <Button
            className="min-h-11"
            size="sm"
            onClick={onApply}
            disabled={!allSelected || active}
            aria-busy={active}
            aria-describedby={!allSelected ? "knowledge-conflict-action-help" : undefined}
          >
            {active ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
            {active ? "Applying…" : "Apply decisions"}
          </Button>
        </div>
      </div>
    </section>
  )
}

function KnowledgeConflictCard({
  conflict,
  ordinal,
  decision,
  disabled,
  onDecision,
}: {
  conflict: CompactKnowledgeConflict
  ordinal: number
  decision?: CompactConflictDecision
  disabled: boolean
  onDecision: (decision: CompactConflictDecision) => void
}) {
  const fieldNames = useMemo(() => conflictFields(conflict), [conflict])
  const differingFields = useMemo(() => {
    const differing = fieldNames.filter((field) => new Set(
      conflict.participants.map((participant) => stableConflictValue(participant.fields[field])),
    ).size > 1)
    return differing.length ? differing : fieldNames
  }, [conflict, fieldNames])
  const [combineOpen, setCombineOpen] = useState(false)
  const [combineSelections, setCombineSelections] = useState<Record<string, string>>({})
  const combinedDecision = decision?.action === "combine" ? decision : null
  const firstParticipantId = conflict.participants[0]?.participantId
  const combinedFieldParticipants = firstParticipantId
    ? Object.fromEntries(fieldNames.map((field) => [field, combineSelections[field] ?? firstParticipantId]))
    : null
  const combineComplete = Boolean(combinedFieldParticipants) && fieldNames.every((field) => Boolean(combinedFieldParticipants?.[field]))
  const sourceWorkItemIds = Array.from(new Set(
    conflict.participants.flatMap((participant) => participant.evidence.map((evidence) => evidence.sourceWorkItemId)),
  ))

  function closeCombineBuilder() {
    setCombineOpen(false)
    setCombineSelections({})
  }

  function openCombineBuilder() {
    if (!firstParticipantId) return null
    const fallbackParticipantId = decision?.action === "keep" ? decision.participantId : firstParticipantId
    setCombineSelections(Object.fromEntries(fieldNames.map((field) => [
      field,
      combinedDecision?.fieldParticipants[field] ?? fallbackParticipantId,
    ])))
    setCombineOpen(true)
  }

  return (
    <article className="rounded-lg border border-border bg-card p-4 outline-none focus-within:ring-2 focus-within:ring-ring" aria-labelledby={`conflict-${conflict.conflictId}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{conflictCategoryLabel(conflict.affectedCategory)}</Badge>
            <span className="font-semibold text-foreground">{conflictTypeLabel(conflict.conflictType)}</span>
            {decision ? (
              <Badge variant="outline" className="gap-1">
                <Check className="size-3.5" aria-hidden="true" />
                {decision.action === "keep" ? "Version selected" : "Entries combined"} — pending apply
              </Badge>
            ) : null}
          </div>
          <h3 id={`conflict-${conflict.conflictId}`} className="mt-2 text-sm font-medium text-foreground">
            {friendlyConflictSubject(conflict.subject)}
          </h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Conflict {ordinal}. These source-backed entries disagree and require a reviewer decision.
          </p>
        </div>
        {sourceWorkItemIds.length ? (
          <div className="flex flex-wrap gap-1" aria-label="Source work item IDs">
            {sourceWorkItemIds.map((id) => <Badge key={id} variant="outline" className="font-mono text-xs">#{id}</Badge>)}
          </div>
        ) : null}
      </div>

      <div className="mt-4 space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          Compare the differing values and their verified source evidence, then keep the version that should be published.
        </p>
        {conflict.participants.length ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {conflict.participants.map((participant, index) => {
              const selected = decision?.action === "keep" && decision.participantId === participant.participantId
              return (
                <fieldset
                  key={participant.participantId}
                  aria-label={`Version ${index + 1}${selected ? ", selected" : ""}`}
                  className={`flex min-w-0 flex-col rounded-lg border-2 p-4 transition-colors motion-reduce:transition-none ${
                    selected ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border bg-muted/40"
                  }`}
                >
                  <legend className="px-1 text-sm font-semibold text-foreground">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      Version {index + 1}
                      {selected ? <Badge className="gap-1"><Check className="size-3.5" aria-hidden="true" />Selected</Badge> : null}
                    </span>
                  </legend>
                  <dl className="space-y-3">
                    {differingFields.map((field) => (
                      <div key={field}>
                        <dt className="text-xs font-semibold text-muted-foreground">{friendlyConflictCode(field)}</dt>
                        <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                          {renderConflictValue(participant.fields[field])}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <CompactConflictEvidence participant={participant} />
                  <Button
                    className="mt-4 min-h-11 w-full sm:w-fit"
                    size="sm"
                    variant={selected ? "default" : "outline"}
                    onClick={() => {
                      closeCombineBuilder()
                      onDecision({ conflictId: conflict.conflictId, action: "keep", participantId: participant.participantId })
                    }}
                    disabled={disabled}
                    aria-label={selected ? `Version ${index + 1} selected` : `Keep version ${index + 1}`}
                    aria-pressed={selected}
                  >
                    <Check className="size-4" aria-hidden="true" /> {selected ? "Selected" : "Keep this version"}
                  </Button>
                </fieldset>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">No supported versions are available.</div>
        )}

        {combinedDecision && !combineOpen ? (
          <CombinedConflictPreview conflict={conflict} fieldParticipants={combinedDecision.fieldParticipants} selected />
        ) : null}

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div role="status" aria-live="polite" className="min-h-5 text-sm font-medium text-success">
            {decision?.action === "keep" ? "Version selected" : decision?.action === "combine" ? "Entries combined" : ""}
          </div>
          {conflict.participants.length > 1 ? (
            <Button
              className="min-h-11"
              size="sm"
              variant="secondary"
              onClick={openCombineBuilder}
              disabled={disabled}
              aria-expanded={combineOpen}
              aria-controls={`${conflict.conflictId}-combine-builder`}
            >
              <GitMerge className="size-4" aria-hidden="true" /> Combine versions
            </Button>
          ) : null}
        </div>

        {combineOpen ? (
          <fieldset id={`${conflict.conflictId}-combine-builder`} className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
            <legend className="px-1 text-sm font-semibold text-foreground">Combine supported versions</legend>
            <p className="text-sm leading-6 text-muted-foreground">
              Choose the source version for each differing field. The combined result updates below; identical fields are carried automatically.
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              {differingFields.map((field, fieldIndex) => {
                const controlId = `${conflict.conflictId}-combine-field-${fieldIndex}`
                return (
                  <div key={field} className="space-y-2">
                    <Label htmlFor={controlId}>Choose source version for {friendlyConflictCode(field)}</Label>
                    <Select
                      value={combineSelections[field]}
                      onValueChange={(participantId) => setCombineSelections((current) => ({ ...current, [field]: participantId }))}
                      disabled={disabled}
                    >
                      <SelectTrigger id={controlId} className="min-h-11">
                        <SelectValue placeholder="Choose a version" />
                      </SelectTrigger>
                      <SelectContent>
                        {conflict.participants.map((participant, participantIndex) => (
                          <SelectItem key={participant.participantId} value={participant.participantId}>
                            Version {participantIndex + 1} — {singleLineConflictValue(participant.fields[field])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )
              })}
            </div>
            {combinedFieldParticipants ? (
              <CombinedConflictPreview conflict={conflict} fieldParticipants={combinedFieldParticipants} />
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button className="min-h-11" size="sm" variant="outline" onClick={closeCombineBuilder} disabled={disabled}>Cancel</Button>
              <Button
                className="min-h-11"
                size="sm"
                onClick={() => {
                  if (!combinedFieldParticipants) return
                  onDecision({
                    conflictId: conflict.conflictId,
                    action: "combine",
                    fieldParticipants: combinedFieldParticipants,
                  })
                  closeCombineBuilder()
                }}
                disabled={disabled || !combineComplete}
              >
                <Check className="size-4" aria-hidden="true" /> Use combined version
              </Button>
            </div>
          </fieldset>
        ) : null}
      </div>
    </article>
  )
}

function CompactConflictEvidence({ participant }: { participant: CompactConflictParticipant }) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-xs font-semibold text-foreground">Source evidence</div>
      {participant.evidence.length ? (
        <div className="mt-2 space-y-2">
          {participant.evidence.map((evidence, index) => (
            <div key={`${evidence.sourceWorkItemId}-${evidence.sourceField}-${index}`} className="rounded-md border border-border bg-card p-3">
              <div className="text-sm font-medium text-foreground">Work item #{evidence.sourceWorkItemId}</div>
              <div className="mt-1 text-xs text-muted-foreground">{friendlyConflictCode(evidence.sourceField)}</div>
              <blockquote className="mt-2 border-l-2 border-primary/40 pl-3 text-sm leading-6 text-muted-foreground">
                “{evidence.quote}”
              </blockquote>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-sm text-muted-foreground">No verified evidence was attached to this version.</div>
      )}
    </div>
  )
}

function CombinedConflictPreview({
  conflict,
  fieldParticipants,
  selected = false,
}: {
  conflict: CompactKnowledgeConflict
  fieldParticipants: Record<string, string>
  selected?: boolean
}) {
  const fields = conflictFields(conflict)
  const participantById = new Map(conflict.participants.map((participant) => [participant.participantId, participant]))
  const selectedParticipantIds = new Set(Object.values(fieldParticipants))
  const evidence = Array.from(new Map(
    conflict.participants
      .filter((participant) => selectedParticipantIds.has(participant.participantId))
      .flatMap((participant) => participant.evidence)
      .map((item) => [`${item.sourceWorkItemId}:${item.sourceField}:${item.quote}`, item]),
  ).values())
  const sourceWorkItemIds = Array.from(new Set(evidence.map((item) => item.sourceWorkItemId)))

  return (
    <section
      aria-label={`Combined entry${selected ? ", selected" : " preview"}`}
      className={`rounded-lg border-2 p-4 ${selected ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border bg-card"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{selected ? "Combined entry" : "Combined entry preview"}</h4>
        {selected ? (
          <Badge className="gap-1"><Check className="size-3.5" aria-hidden="true" />Selected final result</Badge>
        ) : <Badge variant="secondary">Preview</Badge>}
      </div>
      <dl className="mt-4 grid gap-4 md:grid-cols-2">
        {fields.map((field) => {
          const participantId = fieldParticipants[field]
          const participant = participantById.get(participantId) ?? conflict.participants[0]
          const participantIndex = conflict.participants.findIndex((candidate) => candidate.participantId === participant?.participantId)
          return (
            <div key={field} className="min-w-0 rounded-md border border-border bg-background p-3">
              <dt className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-muted-foreground">
                <span>{friendlyConflictCode(field)}</span>
                {participantIndex >= 0 ? <Badge variant="outline">From Version {participantIndex + 1}</Badge> : null}
              </dt>
              <dd className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
                {renderConflictValue(participant?.fields[field])}
              </dd>
            </div>
          )
        })}
      </dl>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-xs font-semibold text-foreground">Source work items</div>
          {sourceWorkItemIds.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {sourceWorkItemIds.map((id) => <Badge key={id} variant="outline">Work Item {id}</Badge>)}
            </div>
          ) : <p className="mt-2 text-sm text-muted-foreground">No source work items are attached.</p>}
        </div>
        <div>
          <div className="text-xs font-semibold text-foreground">Selected evidence</div>
          {evidence.length ? (
            <div className="mt-2 space-y-2">
              {evidence.map((item) => (
                <blockquote key={`${item.sourceWorkItemId}:${item.sourceField}:${item.quote}`} className="rounded-md border border-border bg-background p-3 text-sm leading-6 text-muted-foreground">
                  <span className="mb-1 block text-xs font-medium text-foreground">Work Item {item.sourceWorkItemId} · {friendlyConflictCode(item.sourceField)}</span>
                  “{item.quote}”
                </blockquote>
              ))}
            </div>
          ) : <p className="mt-2 text-sm text-muted-foreground">No evidence is attached.</p>}
        </div>
      </div>
    </section>
  )
}

function ConflictFilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
        active ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {label}<span className="tabular-nums">{count}</span>
    </button>
  )
}

function conflictCategoryLabel(value: string) {
  const labels: Record<string, string> = {
    module: "Modules",
    business_rule: "Business rules",
    state_transition: "State transitions",
    glossary: "Glossary",
    dependency: "Dependencies",
  }
  return labels[value] ?? friendlyConflictCode(value)
}

function conflictTypeLabel(value: string) {
  if (value === "duplicate_identity") return "Different versions"
  if (value === "incompatible_transition_target") return "Conflicting transition targets"
  if (value === "incompatible_concrete_value") return "Conflicting values"
  return "Knowledge conflict"
}

function conflictFields(conflict: CompactKnowledgeConflict) {
  const fieldsByCategory: Record<string, string[]> = {
    module: ["name", "description"],
    business_rule: ["rule", "sourceField", "moduleName"],
    state_transition: ["workflowName", "fromState", "toState", "triggerOrCondition", "actor", "moduleName"],
    glossary: ["term", "type", "definition"],
    dependency: ["sourceModule", "targetModule", "dependencyType", "description"],
  }
  return fieldsByCategory[conflict.affectedCategory]
    ?? Array.from(new Set(conflict.participants.flatMap((participant) => Object.keys(participant.fields))))
}

function friendlyConflictSubject(subject: string) {
  const identityMatch = subject.match(/^identity:[^:]+:(.+)$/)
  if (identityMatch) return friendlyConflictCode(identityMatch[1])
  return subject.split(":").map(friendlyConflictCode).join(" · ")
}

function friendlyConflictCode(value: string) {
  return value.replace(/[_:-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function stableConflictValue(value: unknown) {
  return JSON.stringify(value) ?? String(value)
}

function renderConflictValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not specified"
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return JSON.stringify(value, null, 2)
}

function singleLineConflictValue(value: unknown) {
  const displayed = renderConflictValue(value).replace(/\s+/g, " ")
  return displayed.length > 100 ? `${displayed.slice(0, 97)}…` : displayed
}
