"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  Braces,
  CheckCircle2,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileCheck2,
  GitMerge,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS,
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "@/modules/rag/project-knowledge.schema"
import { mergeProjectKnowledgeConflictEntries } from "@/modules/rag/project-knowledge-consolidation"
import type { ProjectKnowledgeHardConflictParticipant } from "@/modules/rag/project-knowledge-conflicts"
import type {
  ProjectKnowledgeDraftBlocker,
  ProjectKnowledgeEvidenceBlocker,
  ProjectKnowledgeReviewCategory,
  ProjectKnowledgeReviewContext,
  ProjectKnowledgeReviewContextEntry,
  ProjectKnowledgeReviewSource,
  ProjectKnowledgeReviewSummary,
} from "@/modules/rag/project-knowledge-review.contracts"
import { findProjectKnowledgeEntryInstance } from "@/modules/rag/project-knowledge-review.contracts"

type ConflictDecision =
  | {
      kind: "version"
      label: string
      participantId: string
      versionIndex: number
    }
  | {
      kind: "combined"
      label: string
      entry: ProjectKnowledgeHardConflictParticipant["entry"]
      fieldSources: Record<string, number>
    }

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

const PAGE_SIZE = 10

const CATEGORY_LABELS: Record<ProjectKnowledgeReviewCategory, string> = {
  module: "Modules",
  business_rule: "Business rules",
  state_transition: "State transitions",
  glossary: "Glossary",
  dependency: "Dependencies",
  hard_conflict: "Conflicts",
}

const BLOCKER_LABELS: Record<string, string> = {
  missing_evidence_refs: "Evidence link required",
  quote_mismatch: "Evidence quote no longer matches",
  snapshot_missing: "Evidence snapshot unavailable",
  work_item_mismatch: "Evidence points to another work item",
  source_field_missing: "Evidence source field unavailable",
  invalid_business_rule_source_field: "Source field needs review",
  replay_conflict: "Published entry changed",
  hard_conflict: "Knowledge conflict",
}

export function KnowledgeReviewWorkspace({
  draftId,
  status,
  blockers,
  reviewSummary,
  regenerateRequired,
  proposedKnowledge,
  busy,
  onLoadReviewContext,
  onResolve,
  onRebase,
  onRegenerate,
}: Props) {
  const [workingKnowledge, setWorkingKnowledge] = useState<ProjectKnowledgeBase | null>(proposedKnowledge)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<ProjectKnowledgeReviewCategory | "all">("all")
  const [page, setPage] = useState(1)
  const [reviewContext, setReviewContext] = useState<ProjectKnowledgeReviewContext | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [jsonText, setJsonText] = useState(() => JSON.stringify(proposedKnowledge, null, 2))
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [validationRequested, setValidationRequested] = useState(false)
  const [conflictDecisions, setConflictDecisions] = useState<Record<string, ConflictDecision>>({})
  const [regenerateDialogOpen, setRegenerateDialogOpen] = useState(false)
  const firstIssueRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setWorkingKnowledge(proposedKnowledge)
    setJsonText(JSON.stringify(proposedKnowledge, null, 2))
    setSubmitError(null)
    setDirty(false)
    setConflictDecisions({})
  }, [draftId, proposedKnowledge])

  const needsReviewContext = blockers.some((blocker) => isEvidenceBlocker(blocker) || blocker.type === "hard_conflict")
  const jsonValidation = useMemo(() => parseReviewedKnowledge(jsonText), [jsonText])
  const appliedJsonText = workingKnowledge ? JSON.stringify(workingKnowledge, null, 2) : ""
  const jsonDiffersFromApplied = jsonText !== appliedJsonText
  const canApplyJson = jsonDiffersFromApplied && Boolean(jsonValidation.data)

  async function loadReviewContext() {
    if (!needsReviewContext) return
    setContextLoading(true)
    setContextError(null)
    try {
      setReviewContext(await onLoadReviewContext())
    } catch (error) {
      setReviewContext(null)
      setContextError(error instanceof Error ? error.message : "Review sources could not be loaded.")
    } finally {
      setContextLoading(false)
    }
  }

  useEffect(() => {
    if (needsReviewContext) void loadReviewContext()
    else setReviewContext(null)
    // The endpoint callback is intentionally excluded: callers recreate it as draft state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, needsReviewContext])

  useEffect(() => {
    setPage(1)
  }, [category, query, blockers])

  useEffect(() => {
    if (validationRequested && blockers.length) firstIssueRef.current?.focus()
    setValidationRequested(false)
  }, [blockers, validationRequested])

  if (regenerateRequired) {
    return (
      <>
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground">
          <div className="font-semibold">Compiler contract changed</div>
          <p className="mt-1 text-xs">This proposal uses incompatible validation semantics and must be regenerated.</p>
          <Button className="mt-3 min-h-11" size="sm" variant="outline" onClick={() => setRegenerateDialogOpen(true)} disabled={busy}>
            {busy ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}
            Refresh sources and regenerate draft
          </Button>
        </div>
        <AlertDialog open={regenerateDialogOpen} onOpenChange={setRegenerateDialogOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Refresh sources and regenerate this draft?</AlertDialogTitle>
              <AlertDialogDescription>
                The project index will be refreshed before a replacement draft is created. {dirty
                  ? "Your staged review changes will not carry into the replacement draft."
                  : "The current draft will remain available if regeneration fails."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep current draft</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => void onRegenerate()}>
                Refresh sources and regenerate
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    )
  }

  if (status === "rebase_required") {
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground">
        <div className="font-semibold">Source or publication baseline changed</div>
        <p className="mt-1 text-xs">Create a child draft against the latest sources before continuing review.</p>
        <Button className="mt-3 min-h-11" size="sm" variant="outline" onClick={() => void onRebase()} disabled={busy}>
          {busy ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}
          Rebase draft
        </Button>
      </div>
    )
  }

  if (!blockers.length) {
    return (
      <div role="status" aria-live="polite" className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/10 p-4 text-sm text-success">
        <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div>
          <div className="font-semibold">Review checks passed</div>
          <p className="mt-1 text-xs">
            {reviewSummary.automaticDuplicateConsolidations > 0
              ? `${reviewSummary.automaticDuplicateConsolidations} duplicate ${reviewSummary.automaticDuplicateConsolidations === 1 ? "entry was" : "entries were"} consolidated automatically. `
              : ""}
            {reviewSummary.automaticEvidenceRepairs > 0
              ? `${reviewSummary.automaticEvidenceRepairs} evidence ${reviewSummary.automaticEvidenceRepairs === 1 ? "link was" : "links were"} restored automatically. `
              : ""}
            Publication still requires the explicit Publish action below.
          </p>
        </div>
      </div>
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = blockers.filter((blocker) => {
    const categoryMatches = category === "all" || reviewCategory(blocker) === category
    if (!categoryMatches) return false
    if (!normalizedQuery) return true
    const entry = workingKnowledge
      ? findKnowledgeEntry(workingKnowledge, blocker.category, blocker.entryKey, blocker.entryInstanceId)
      : null
    return [
      BLOCKER_LABELS[blocker.type] ?? blocker.type,
      blocker.entryKey,
      blocker.message,
      entry ? entryTitle(blocker.category, entry) : "",
      ...("sourceWorkItemIds" in blocker ? blocker.sourceWorkItemIds : []),
      ...(blocker.type === "hard_conflict"
        ? blocker.participants.flatMap((participant) => [
            participant.entryKey,
            participant.evidence,
            ...participant.sourceWorkItemIds,
            JSON.stringify(participant.projection),
          ])
        : []),
    ].join(" ").toLowerCase().includes(normalizedQuery)
  })
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  const visibleWithKeys = withUniqueRenderKeys(visible)
  const typeSummaries = Object.entries(reviewSummary.byType)
  const categorySummaries = Object.entries(reviewSummary.byCategory)
  const onlyHardConflicts = blockers.every((blocker) => blocker.type === "hard_conflict")
  const hasHardConflicts = blockers.some((blocker) => blocker.type === "hard_conflict")

  function updateWorkingKnowledge(next: ProjectKnowledgeBase) {
    setWorkingKnowledge(next)
    setJsonText(JSON.stringify(next, null, 2))
    setSubmitError(null)
    setDirty(true)
  }

  function resetWorkingKnowledge() {
    if (!proposedKnowledge) return
    setWorkingKnowledge(proposedKnowledge)
    setJsonText(JSON.stringify(proposedKnowledge, null, 2))
    setSubmitError(null)
    setDirty(false)
    setConflictDecisions({})
  }

  function applyJsonToReview() {
    if (!jsonValidation.data || !jsonDiffersFromApplied) return
    updateWorkingKnowledge(jsonValidation.data)
    setConflictDecisions({})
  }

  async function validateChanges() {
    if (!workingKnowledge || !dirty) return
    setSubmitError(null)
    try {
      setValidationRequested(true)
      await onResolve(workingKnowledge)
    } catch (error) {
      setValidationRequested(false)
      setSubmitError(error instanceof Error ? error.message : "Review validation failed.")
    }
  }

  return (
    <section className="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4" aria-labelledby="knowledge-review-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <h3 id="knowledge-review-title" className="text-sm font-semibold text-destructive">
              {onlyHardConflicts
                ? `${blockers.length} knowledge ${blockers.length === 1 ? "conflict needs" : "conflicts need"} review before publishing`
                : "Publication review required"}
            </h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {reviewSummary.automaticDuplicateConsolidations > 0
                ? `${reviewSummary.automaticDuplicateConsolidations} duplicate ${reviewSummary.automaticDuplicateConsolidations === 1 ? "entry was" : "entries were"} consolidated automatically; `
                : ""}
              {reviewSummary.automaticEvidenceRepairs > 0
                ? `${reviewSummary.automaticEvidenceRepairs} evidence ${reviewSummary.automaticEvidenceRepairs === 1 ? "link was" : "links were"} repaired automatically; `
                : ""}
              Review only the entries below that still need a decision.
            </p>
          </div>
        </div>
        <Badge variant="destructive" className="w-fit tabular-nums">{blockers.length} unresolved</Badge>
      </div>

      {typeSummaries.length > 1 ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Review issue summary">
          {typeSummaries.map(([type, count]) => (
            <div key={type} className="rounded-md border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">{BLOCKER_LABELS[type] ?? friendlyCode(type)}</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{count}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {categorySummaries.length > 1 ? (
          <div role="group" aria-label="Filter review issues by category" className="flex flex-wrap gap-2">
            <FilterButton label="All" count={blockers.length} active={category === "all"} onClick={() => setCategory("all")} />
            {categorySummaries.map(([key, count]) => (
              <FilterButton
                key={key}
                label={CATEGORY_LABELS[key as ProjectKnowledgeReviewCategory] ?? friendlyCode(key)}
                count={count}
                active={category === key}
                onClick={() => setCategory(key as ProjectKnowledgeReviewCategory)}
              />
            ))}
          </div>
        ) : <div />}
        <div className="relative w-full lg:w-[360px]">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            className="h-11 pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search issues, entries, or work items"
            aria-label="Search publication review issues"
          />
        </div>
      </div>

      {contextError ? (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="text-destructive">{contextError}</span>
          <Button className="min-h-11" size="sm" variant="outline" onClick={() => void loadReviewContext()} disabled={contextLoading}>
            {contextLoading ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-4" />}
            Retry source loading
          </Button>
        </div>
      ) : null}

      <div className="space-y-3" role="list" aria-label="Unresolved publication issues">
        {visibleWithKeys.length ? visibleWithKeys.map(({ blocker, renderKey }, index) => {
          const entry = workingKnowledge ? findKnowledgeEntry(workingKnowledge, blocker.category, blocker.entryKey, blocker.entryInstanceId) : null
          const contextEntry = reviewContext?.entries.find((candidate) =>
            candidate.category === blocker.category &&
            (blocker.entryInstanceId && candidate.entryInstanceId
              ? candidate.entryInstanceId === blocker.entryInstanceId
              : canonicalKey(candidate.entryKey) === canonicalKey(blocker.entryKey)))
          const title = blocker.type === "hard_conflict"
            ? friendlyConflictSubject(blocker.subject)
            : entry
              ? entryTitle(blocker.category, entry)
              : blocker.entryKey
          return (
            <div
              key={renderKey}
              ref={index === 0 ? firstIssueRef : undefined}
              tabIndex={index === 0 ? -1 : undefined}
              role="listitem"
              className="rounded-lg border border-border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{CATEGORY_LABELS[reviewCategory(blocker)]}</Badge>
                    <span className="font-semibold text-foreground">
                      {blocker.type === "hard_conflict" ? hardConflictLabel(blocker.conflictType) : BLOCKER_LABELS[blocker.type] ?? friendlyCode(blocker.type)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm font-medium text-foreground">
                    {title}
                  </div>
                  {blocker.type !== "hard_conflict" ? (
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{blocker.entryKey}</div>
                  ) : null}
                  <p className="mt-2 text-sm text-muted-foreground">{blocker.message}</p>
                </div>
                {"sourceWorkItemIds" in blocker && blocker.sourceWorkItemIds.length ? (
                  <div className="flex flex-wrap gap-1" aria-label="Source work item IDs">
                    {blocker.sourceWorkItemIds.map((id) => <Badge key={id} variant="outline" className="font-mono text-xs">{id}</Badge>)}
                  </div>
                ) : null}
              </div>

              {entry && isEvidenceBlocker(blocker) ? (
                <EvidenceRepairEditor
                  blocker={blocker}
                  entry={entry}
                  contextEntry={contextEntry}
                  contextLoading={contextLoading}
                  contextError={contextError}
                  busy={busy}
                  onRetry={() => void loadReviewContext()}
                  onRequestRegenerate={() => setRegenerateDialogOpen(true)}
                  onChange={(refs) => workingKnowledge && updateWorkingKnowledge(setEntryEvidenceRefs(
                    workingKnowledge,
                    blocker.category,
                    blocker.entryKey,
                    refs,
                    blocker.entryInstanceId,
                  ))}
                />
              ) : null}

              {!entry && blocker.type !== "hard_conflict" ? (
                <UnavailableIssueState
                  workItemIds={"sourceWorkItemIds" in blocker ? blocker.sourceWorkItemIds : []}
                  onRequestRegenerate={() => setRegenerateDialogOpen(true)}
                  busy={busy}
                />
              ) : null}

              {entry && blocker.type === "invalid_business_rule_source_field" ? (
                <BusinessRuleSourceFieldEditor
                  entry={entry}
                  blockerId={blocker.id}
                  busy={busy}
                  onChange={(sourceField) => workingKnowledge && updateWorkingKnowledge(
                    setKnowledgeEntryField(
                      workingKnowledge,
                      "business_rule",
                      blocker.entryKey,
                      "sourceField",
                      sourceField,
                      blocker.entryInstanceId,
                    ),
                  )}
                />
              ) : null}

              {blocker.type === "replay_conflict" ? (
                <ReplayConflictEditor
                  blocker={blocker}
                  onUse={(value) => workingKnowledge && updateWorkingKnowledge(setKnowledgeEntryValue(
                    workingKnowledge,
                    blocker.category,
                    blocker.entryKey,
                    value,
                    blocker.entryInstanceId,
                  ))}
                />
              ) : null}

              {blocker.type === "hard_conflict" ? (
                <HardConflictEditor
                  blocker={blocker}
                  sources={reviewContext?.sources ?? []}
                  contextLoading={contextLoading}
                  busy={busy}
                  decision={conflictDecisions[blocker.entryInstanceId ?? blocker.id]}
                  onRequestRegenerate={() => setRegenerateDialogOpen(true)}
                  onKeep={(participant, index) => {
                    if (!workingKnowledge) return
                    updateWorkingKnowledge(replaceConflictGroup(workingKnowledge, blocker, participant.entry))
                    setConflictDecisions((current) => ({
                      ...current,
                      [blocker.entryInstanceId ?? blocker.id]: {
                        kind: "version",
                        label: `Version ${index + 1} selected`,
                        participantId: participant.participantId,
                        versionIndex: index,
                      },
                    }))
                  }}
                  onCombine={(merged, fieldSources) => {
                    if (!workingKnowledge) return
                    updateWorkingKnowledge(replaceConflictGroup(workingKnowledge, blocker, merged))
                    setConflictDecisions((current) => ({
                      ...current,
                      [blocker.entryInstanceId ?? blocker.id]: { kind: "combined", label: "Entries combined", entry: merged, fieldSources },
                    }))
                  }}
                />
              ) : null}
            </div>
          )
        }) : (
          <div className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">
            No unresolved issues match the current filters.
          </div>
        )}
      </div>

      {filtered.length > PAGE_SIZE ? (
        <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>Showing {(safePage - 1) * PAGE_SIZE + 1}-{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}</span>
          <div className="flex gap-2">
            <Button className="min-h-11" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <Button className="min-h-11" size="sm" variant="outline" disabled={safePage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {workingKnowledge ? (
        <Accordion type="single" collapsible>
          <AccordionItem value="advanced-json">
            <AccordionTrigger className="min-h-11">
              <span className="flex items-center gap-2"><Braces className="size-4" aria-hidden="true" />Advanced JSON</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              <p className="text-xs leading-5 text-muted-foreground">
                Advanced JSON is an expert fallback. Applying edited JSON replaces the guided working state, but does not contact the server until you re-check the review.
              </p>
              <Label htmlFor="knowledge-review-json">Complete reviewed proposal</Label>
              <Textarea
                id="knowledge-review-json"
                value={jsonText}
                onChange={(event) => {
                  setJsonText(event.target.value)
                }}
                aria-invalid={Boolean(jsonValidation.error)}
                aria-describedby={jsonValidation.error ? "knowledge-review-json-error" : "knowledge-review-json-help"}
                className="min-h-72 font-mono text-xs"
                spellCheck={false}
              />
              {jsonValidation.error ? (
                <pre id="knowledge-review-json-error" role="alert" className="whitespace-pre-wrap text-xs text-destructive">{jsonValidation.error}</pre>
              ) : (
                <p id="knowledge-review-json-help" className="text-xs text-muted-foreground">
                  {jsonDiffersFromApplied ? "The edited proposal is valid and ready to apply." : "Edit the JSON to enable Apply edited JSON."}
                </p>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button className="min-h-11" size="sm" variant="outline" onClick={resetWorkingKnowledge} disabled={busy}>
                  <RotateCcw className="size-4" /> Reset to server proposal
                </Button>
                <Button className="min-h-11" size="sm" variant="secondary" onClick={applyJsonToReview} disabled={busy || !canApplyJson}>
                  <FileCheck2 className="size-4" /> Apply edited JSON
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      ) : null}

      {submitError ? <div role="alert" className="text-sm text-destructive">{submitError}</div> : null}
      <div aria-live="polite" className="sr-only">
        {dirty ? "Review changes have not been validated." : `${blockers.length} publication issues remain.`}
      </div>
      <div className="space-y-2 border-t border-border pt-4">
        {!dirty ? (
          <p id="knowledge-review-action-help" className="text-right text-xs text-muted-foreground">
            Resolve an issue or apply an edited proposal before re-checking.
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button className="min-h-11" size="sm" variant="outline" onClick={resetWorkingKnowledge} disabled={busy || !dirty}>
            <RotateCcw className="size-4" /> Discard review changes
          </Button>
          <Button
            className="min-h-11"
            size="sm"
            onClick={() => void validateChanges()}
            disabled={busy || !dirty || !workingKnowledge}
            aria-busy={busy}
            aria-describedby={!dirty ? "knowledge-review-action-help" : undefined}
          >
            {busy ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <ShieldCheck className="size-4" />}
            {busy ? "Checking..." : hasHardConflicts ? "Save decisions and re-check" : "Validate review changes"}
          </Button>
        </div>
      </div>
      <AlertDialog open={regenerateDialogOpen} onOpenChange={setRegenerateDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Refresh sources and regenerate this draft?</AlertDialogTitle>
            <AlertDialogDescription>
              The project index will be refreshed before a replacement draft is created. {dirty
                ? "Your staged review changes will not carry into the replacement draft."
                : "The current draft will remain available if regeneration fails."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Keep current draft</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void onRegenerate()}>
              Refresh sources and regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function EvidenceRepairEditor({
  blocker,
  entry,
  contextEntry,
  contextLoading,
  contextError,
  busy,
  onRetry,
  onRequestRegenerate,
  onChange,
}: {
  blocker: ProjectKnowledgeEvidenceBlocker
  entry: Record<string, unknown>
  contextEntry?: ProjectKnowledgeReviewContextEntry
  contextLoading: boolean
  contextError: string | null
  busy: boolean
  onRetry: () => void
  onRequestRegenerate: () => void
  onChange: (refs: ProjectKnowledgeEvidenceRef[]) => void
}) {
  const refs = Array.isArray(entry.evidenceRefs) ? entry.evidenceRefs as ProjectKnowledgeEvidenceRef[] : []
  const [sourceId, setSourceId] = useState("")
  const [sourceField, setSourceField] = useState("")
  const [quote, setQuote] = useState("")
  const [selection, setSelection] = useState("")
  const [error, setError] = useState<string | null>(null)
  const sourceTextarea = useRef<HTMLTextAreaElement | null>(null)
  const sources = useMemo(() => contextEntry?.sources ?? [], [contextEntry])
  const usableSources = useMemo(() => sources.filter((candidate) => candidate.fields.length), [sources])
  const source = usableSources.find((candidate) => candidate.sourceSnapshotId === sourceId) ?? usableSources[0]
  const field = source?.fields.find((candidate) => candidate.sourceField === sourceField) ?? source?.fields[0]
  const affectedWorkItemIds = contextEntry?.affectedWorkItemIds?.length
    ? contextEntry.affectedWorkItemIds
    : blocker.sourceWorkItemIds
  const availability = contextEntry?.sourceAvailability ?? (usableSources.length ? "available" : "snapshot_missing")

  useEffect(() => {
    if (!sourceId && usableSources[0]) setSourceId(usableSources[0].sourceSnapshotId)
  }, [sourceId, usableSources])

  useEffect(() => {
    if (source && (!sourceField || !source.fields.some((candidate) => candidate.sourceField === sourceField))) {
      setSourceField(source.fields[0]?.sourceField ?? "")
      setQuote("")
      setSelection("")
    }
  }, [source, sourceField])

  function captureSelection() {
    const element = sourceTextarea.current
    if (!element) return
    const selected = element.value.slice(element.selectionStart, element.selectionEnd)
    setSelection(selected)
  }

  function addReference() {
    if (!source || !field) {
      setError("Choose an immutable source and field.")
      return
    }
    const exactQuote = quote.trim()
    if (!exactQuote || !field.text.includes(exactQuote)) {
      setError("The quote must be copied exactly from the selected source field.")
      return
    }
    const nextRef: ProjectKnowledgeEvidenceRef = {
      sourceSnapshotId: source.sourceSnapshotId,
      sourceWorkItemId: source.sourceWorkItemId,
      sourceField: field.sourceField,
      quote: exactQuote,
      origin: "reviewer_reanchored",
      verification: "exact",
    }
    const retained = blocker.type === "missing_evidence_refs"
      ? refs
      : refs.filter((ref) => !(
          (!blocker.sourceSnapshotId || ref.sourceSnapshotId === blocker.sourceSnapshotId) &&
          (!blocker.sourceField || ref.sourceField === blocker.sourceField)
        ))
    onChange([...retained, nextRef])
    setQuote("")
    setSelection("")
    setError(null)
  }

  return (
    <fieldset className="mt-4 space-y-4 rounded-md border border-border bg-muted/50 p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">Repair evidence</legend>
      <div className="rounded-md bg-card p-3 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">Current evidence:</span> {String(entry.evidence ?? "No evidence text provided")}
      </div>
      {refs.length ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold text-foreground">Evidence references in the working proposal</div>
          {refs.map((ref, index) => (
            <div key={`${ref.sourceSnapshotId}-${ref.sourceField}-${index}`} className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-xs text-muted-foreground">
                <div className="font-semibold text-foreground">Work item {ref.sourceWorkItemId} · {friendlyCode(ref.sourceField)}</div>
                <div className="mt-1 break-words">“{ref.quote}”</div>
              </div>
              <Button className="min-h-11 shrink-0" size="sm" variant="ghost" onClick={() => onChange(refs.filter((_, refIndex) => refIndex !== index))}>
                <Trash2 className="size-4" /> Remove
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {contextLoading ? (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> Loading immutable sources...
        </div>
      ) : contextError ? (
        <div className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-card p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-semibold text-destructive">Source details could not be loaded</div>
            <p className="mt-1 text-xs text-muted-foreground">Retry the source request before editing this evidence reference.</p>
          </div>
          <Button className="min-h-11 shrink-0" size="sm" variant="outline" onClick={onRetry} disabled={busy}>
            <RefreshCw className="size-4" /> Retry source loading
          </Button>
        </div>
      ) : availability === "available" && usableSources.length ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.3fr)]">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={`${blocker.id}-source`}>Source work item</Label>
              <Select value={source?.sourceSnapshotId ?? ""} onValueChange={(value) => {
                setSourceId(value)
                setError(null)
              }}>
                <SelectTrigger id={`${blocker.id}-source`} className="h-11 w-full"><SelectValue placeholder="Choose source" /></SelectTrigger>
                <SelectContent>
                  {usableSources.map((candidate) => (
                    <SelectItem key={candidate.sourceSnapshotId} value={candidate.sourceSnapshotId}>Work item {candidate.sourceWorkItemId}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${blocker.id}-field`}>Source field</Label>
              <Select value={field?.sourceField ?? ""} onValueChange={(value) => {
                setSourceField(value)
                setQuote("")
                setSelection("")
                setError(null)
              }}>
                <SelectTrigger id={`${blocker.id}-field`} className="h-11 w-full"><SelectValue placeholder="Choose field" /></SelectTrigger>
                <SelectContent>
                  {source?.fields.map((candidate) => (
                    <SelectItem key={candidate.sourceField} value={candidate.sourceField}>{friendlyCode(candidate.sourceField)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${blocker.id}-quote`}>Exact evidence quote</Label>
              <Textarea
                id={`${blocker.id}-quote`}
                value={quote}
                onChange={(event) => {
                  setQuote(event.target.value)
                  setError(null)
                }}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${blocker.id}-quote-error` : `${blocker.id}-quote-help`}
                className="min-h-24"
                placeholder="Select text from the source or paste an exact quote"
              />
              <p id={`${blocker.id}-quote-help`} className="text-xs text-muted-foreground">The quote must be an exact substring of the immutable field.</p>
              {error ? <p id={`${blocker.id}-quote-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${blocker.id}-source-text`}>Immutable source text</Label>
            <Textarea
              ref={sourceTextarea}
              id={`${blocker.id}-source-text`}
              value={field?.text ?? ""}
              readOnly
              onSelect={captureSelection}
              className="min-h-52 bg-card font-mono text-xs"
              aria-describedby={`${blocker.id}-source-help`}
            />
            <p id={`${blocker.id}-source-help`} className="text-xs text-muted-foreground">Select the smallest passage that directly supports this entry.</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Button className="min-h-11" size="sm" variant="outline" disabled={!selection.trim()} onClick={() => {
                setQuote(selection)
                setError(null)
              }}>
                Use selected text
              </Button>
              <Button className="min-h-11" size="sm" variant="outline" disabled={!field?.text} onClick={() => {
                setQuote(field?.text ?? "")
                setError(null)
              }}>
                Use entire field
              </Button>
              <Button className="min-h-11 sm:ml-auto" size="sm" onClick={addReference}>
                <FileCheck2 className="size-4" /> Add evidence reference
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-semibold">{sourceAvailabilityTitle(availability, affectedWorkItemIds)}</div>
            <p className="mt-1 text-xs leading-5">
              This entry cannot be verified in the current draft. Refresh the indexed sources and create a replacement draft.
            </p>
          </div>
          <Button className="min-h-11 shrink-0" size="sm" variant="outline" onClick={onRequestRegenerate} disabled={busy}>
            <RefreshCw className="size-4" /> Refresh sources and regenerate draft
          </Button>
        </div>
      )}
    </fieldset>
  )
}

function UnavailableIssueState({
  workItemIds,
  busy,
  onRequestRegenerate,
}: {
  workItemIds: string[]
  busy: boolean
  onRequestRegenerate: () => void
}) {
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="font-semibold">The proposal entry could not be matched to this review issue</div>
        <p className="mt-1 text-xs leading-5">
          {workItemIds.length ? `Affected work ${workItemIds.length === 1 ? "item" : "items"}: ${workItemIds.join(", ")}. ` : ""}
          Refresh the indexed sources and regenerate the draft to rebuild its review context.
        </p>
      </div>
      <Button className="min-h-11 shrink-0" size="sm" variant="outline" onClick={onRequestRegenerate} disabled={busy}>
        <RefreshCw className="size-4" /> Refresh sources and regenerate draft
      </Button>
    </div>
  )
}

function BusinessRuleSourceFieldEditor({
  entry,
  blockerId,
  busy,
  onChange,
}: {
  entry: Record<string, unknown>
  blockerId: string
  busy: boolean
  onChange: (sourceField: string) => void
}) {
  return (
    <fieldset className="mt-4 space-y-3 rounded-md border border-border bg-muted/50 p-4">
      <legend className="px-1 text-sm font-semibold text-foreground">Choose a supported source field</legend>
      <p className="text-sm text-muted-foreground">
        Select the immutable work-item field that supports this business rule.
      </p>
      <div className="max-w-md space-y-2">
        <Label htmlFor={`${blockerId}-business-rule-source-field`}>Source field</Label>
        <Select value={String(entry.sourceField ?? "")} onValueChange={onChange} disabled={busy}>
          <SelectTrigger id={`${blockerId}-business-rule-source-field`} className="h-11 w-full">
            <SelectValue placeholder="Choose source field" />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS.map((sourceField) => (
              <SelectItem key={sourceField} value={sourceField}>{friendlyCode(sourceField)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </fieldset>
  )
}

function ReplayConflictEditor({ blocker, onUse }: {
  blocker: Extract<ProjectKnowledgeDraftBlocker, { type: "replay_conflict" }>
  onUse: (value: Record<string, unknown> | null) => void
}) {
  return (
    <div className="mt-4 space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        {(["base", "latest", "proposed"] as const).map((key) => (
          <div key={key} className="rounded-md border border-border bg-muted p-3">
            <div className="mb-2 text-xs font-semibold capitalize text-foreground">{key}</div>
            <DefinitionRows value={blocker[key]} />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button className="min-h-11" size="sm" variant="outline" onClick={() => onUse(blocker.latest)}>Keep latest</Button>
        <Button className="min-h-11" size="sm" onClick={() => onUse(blocker.proposed)}>Use proposed</Button>
      </div>
    </div>
  )
}

function HardConflictEditor({
  blocker,
  sources,
  contextLoading,
  busy,
  decision,
  onRequestRegenerate,
  onKeep,
  onCombine,
}: {
  blocker: Extract<ProjectKnowledgeDraftBlocker, { type: "hard_conflict" }>
  sources: ProjectKnowledgeReviewSource[]
  contextLoading: boolean
  busy: boolean
  decision?: ConflictDecision
  onRequestRegenerate: () => void
  onKeep: (participant: ProjectKnowledgeHardConflictParticipant, index: number) => void
  onCombine: (entry: ProjectKnowledgeHardConflictParticipant["entry"], fieldSources: Record<string, number>) => void
}) {
  const differingKeys = conflictProjectionKeys(blocker.participants)
  const [combineOpen, setCombineOpen] = useState(false)
  const [combineSelections, setCombineSelections] = useState<Record<string, string>>({})
  const [combinePreview, setCombinePreview] = useState<{
    entry: ProjectKnowledgeHardConflictParticipant["entry"]
    fieldSources: Record<string, number>
  } | null>(null)
  const combineComplete = differingKeys.every((key) => Boolean(combineSelections[key]))

  function closeCombineBuilder() {
    setCombineOpen(false)
    setCombineSelections({})
    setCombinePreview(null)
  }

  function previewCombinedEntry() {
    if (!combineComplete) return
    const selectedIndexes = Array.from(new Set(
      differingKeys.map((key) => Number(combineSelections[key])),
    ))
    const selectedParticipants = selectedIndexes.map((index) => blocker.participants[index])
    const merged = mergeProjectKnowledgeConflictEntries(
      blocker.affectedCategory,
      selectedParticipants.map((participant) => participant.entry),
    )
    const combined = structuredClone(merged) as ProjectKnowledgeHardConflictParticipant["entry"]
    const combinedRecord = combined as unknown as Record<string, unknown>

    differingKeys.forEach((key) => {
      const participant = blocker.participants[Number(combineSelections[key])]
      const selectedValue = participant.projection[key]
      if (selectedValue === null || selectedValue === undefined) delete combinedRecord[key]
      else combinedRecord[key] = structuredClone(selectedValue)
    })

    setCombinePreview({
      entry: combined,
      fieldSources: Object.fromEntries(differingKeys.map((key) => [key, Number(combineSelections[key])])),
    })
  }

  function useCombinedEntry() {
    if (!combinePreview) return
    onCombine(combinePreview.entry, combinePreview.fieldSources)
    closeCombineBuilder()
  }

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm leading-6 text-muted-foreground">
        Compare the values and their source evidence, then keep the version that should be published.
      </p>
      {blocker.participants.length ? (
        <div className="grid gap-4 xl:grid-cols-2">
          {blocker.participants.map((participant, index) => {
            const selected = decision?.kind === "version" && decision.participantId === participant.participantId
            return (
              <fieldset
                key={participant.participantId}
                aria-label={`Version ${index + 1}${selected ? ", selected" : ""}`}
                className={`flex min-w-0 flex-col rounded-lg border-2 p-4 transition-colors motion-reduce:transition-none ${
                  selected
                    ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                    : "border-border bg-muted/40"
                }`}
              >
                <legend className="px-1 text-sm font-semibold text-foreground">
                  <span className="inline-flex flex-wrap items-center gap-2">
                    Version {index + 1}
                    {selected ? <Badge className="gap-1"><Check className="size-3.5" aria-hidden="true" />Selected</Badge> : null}
                  </span>
                </legend>
                <dl className="space-y-3">
                  {differingKeys.map((key) => (
                    <div key={key}>
                      <dt className="text-xs font-semibold text-muted-foreground">{friendlyCode(key)}</dt>
                      <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-foreground">
                        {displayConflictValue(participant.projection[key])}
                      </dd>
                    </div>
                  ))}
                </dl>
                <ConflictEvidence participant={participant} sources={sources} contextLoading={contextLoading} />
                <Button
                  className="mt-4 min-h-11 w-full sm:w-fit"
                  size="sm"
                  variant={selected ? "default" : "outline"}
                  onClick={() => {
                    closeCombineBuilder()
                    onKeep(participant, index)
                  }}
                  disabled={busy}
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
        <UnavailableIssueState workItemIds={[]} busy={busy} onRequestRegenerate={onRequestRegenerate} />
      )}
      {decision?.kind === "combined" ? (
        <CombinedEntryPreview
          entry={decision.entry}
          fieldSources={decision.fieldSources}
          sources={sources}
          title="Combined entry"
          selected
        />
      ) : null}
      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div role="status" aria-live="polite" className="min-h-5 text-sm font-medium text-success">
            {decision?.label ?? ""}
          </div>
          {blocker.conflictType === "duplicate_identity" && blocker.participants.length > 1 ? (
            <p className="mt-1 text-xs text-muted-foreground">Review and combine lets you choose every differing value and keeps evidence only from the versions you use.</p>
          ) : null}
        </div>
        {blocker.conflictType === "duplicate_identity" && blocker.participants.length > 1 ? (
          <Button
            className="min-h-11"
            size="sm"
            variant="secondary"
            onClick={() => {
              setCombineOpen(true)
              setCombineSelections({})
              setCombinePreview(null)
            }}
            disabled={busy}
            aria-expanded={combineOpen}
            aria-controls={`${blocker.id}-combine-builder`}
          >
            <GitMerge className="size-4" aria-hidden="true" /> Review and combine
          </Button>
        ) : null}
      </div>
      {combineOpen ? (
        <fieldset id={`${blocker.id}-combine-builder`} className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <legend className="px-1 text-sm font-semibold text-foreground">Review combined entry</legend>
          {combinePreview ? (
            <>
              <p className="text-sm leading-6 text-muted-foreground">
                Review the complete result and its provenance. The proposal is unchanged until you use this combined entry.
              </p>
              <CombinedEntryPreview
                entry={combinePreview.entry}
                fieldSources={combinePreview.fieldSources}
                sources={sources}
                title="Combined entry preview"
              />
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button className="min-h-11" size="sm" variant="ghost" onClick={closeCombineBuilder} disabled={busy}>
                  Cancel merge
                </Button>
                <Button className="min-h-11" size="sm" variant="outline" onClick={() => setCombinePreview(null)} disabled={busy}>
                  Back to choices
                </Button>
                <Button className="min-h-11" size="sm" onClick={useCombinedEntry} disabled={busy}>
                  <Check className="size-4" aria-hidden="true" /> Use combined entry
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm leading-6 text-muted-foreground">
                Choose a source version for every differing field. Only versions used below contribute evidence and source work items.
              </p>
          <div className="grid gap-4 lg:grid-cols-2">
            {differingKeys.map((key, fieldIndex) => {
              const controlId = `${blocker.id}-combine-field-${fieldIndex}`
              return (
                <div key={key} className="space-y-2">
                  <Label htmlFor={controlId}>Choose source version for {friendlyCode(key)}</Label>
                  <select
                    id={controlId}
                    className="flex h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    value={combineSelections[key] ?? ""}
                    onChange={(event) => setCombineSelections((current) => ({
                      ...current,
                      [key]: event.target.value,
                    }))}
                    disabled={busy}
                  >
                    <option value="" disabled>Choose a version</option>
                    {blocker.participants.map((participant, participantIndex) => (
                      <option key={participant.participantId} value={String(participantIndex)}>
                        Version {participantIndex + 1} — {singleLineConflictValue(participant.projection[key])}
                      </option>
                    ))}
                  </select>
                </div>
              )
            })}
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button className="min-h-11" size="sm" variant="outline" onClick={closeCombineBuilder} disabled={busy}>
              Cancel merge
            </Button>
            <Button className="min-h-11" size="sm" onClick={previewCombinedEntry} disabled={busy || !combineComplete}>
              <GitMerge className="size-4" aria-hidden="true" /> Preview combined entry
            </Button>
          </div>
            </>
          )}
        </fieldset>
      ) : null}
    </div>
  )
}

function CombinedEntryPreview({
  entry,
  fieldSources,
  sources,
  title,
  selected = false,
}: {
  entry: ProjectKnowledgeHardConflictParticipant["entry"]
  fieldSources: Record<string, number>
  sources: ProjectKnowledgeReviewSource[]
  title: string
  selected?: boolean
}) {
  const record = entry as unknown as Record<string, unknown>
  const sourceWorkItemIds = Array.isArray(record.sourceWorkItemIds)
    ? record.sourceWorkItemIds.filter((value): value is string => typeof value === "string")
    : []
  const evidenceRefs = Array.isArray(record.evidenceRefs)
    ? record.evidenceRefs as ProjectKnowledgeEvidenceRef[]
    : []
  const semanticFields = Object.entries(record).filter(([key, value]) =>
    !["evidence", "evidenceRefs", "sourceWorkItemIds"].includes(key) && value !== undefined)

  return (
    <section
      aria-label={`${title}${selected ? ", selected" : ""}`}
      className={`rounded-lg border-2 p-4 ${
        selected ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "border-border bg-card"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {selected ? (
          <Badge className="gap-1"><Check className="size-3.5" aria-hidden="true" />Selected final result</Badge>
        ) : (
          <Badge variant="secondary">Preview</Badge>
        )}
      </div>
      <dl className="mt-4 grid gap-4 md:grid-cols-2">
        {semanticFields.map(([key, value]) => (
          <div key={key} className="min-w-0 rounded-md border border-border bg-background p-3">
            <dt className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-muted-foreground">
              <span>{friendlyCode(key)}</span>
              {fieldSources[key] !== undefined ? (
                <Badge variant="outline">From Version {fieldSources[key] + 1}</Badge>
              ) : null}
            </dt>
            <dd className="mt-2 whitespace-pre-wrap break-words text-sm text-foreground">
              {displayConflictValue(value)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <div className="text-xs font-semibold text-foreground">Source work items</div>
          {sourceWorkItemIds.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {sourceWorkItemIds.map((id) => {
                const source = sources.find((candidate) => candidate.sourceWorkItemId === id)
                return source?.workItemUrl ? (
                  <a
                    key={id}
                    href={source.workItemUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center gap-1 rounded-md border border-border px-3 text-xs font-medium text-primary outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    #{id} {source.workItemTitle}<ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ) : <Badge key={id} variant="outline">Work Item {id}</Badge>
              })}
            </div>
          ) : <p className="mt-2 text-sm text-muted-foreground">No source work items are attached.</p>}
        </div>
        <div>
          <div className="text-xs font-semibold text-foreground">Selected evidence</div>
          {evidenceRefs.length ? (
            <div className="mt-2 space-y-2">
              {evidenceRefs.map((ref) => (
                <blockquote
                  key={`${ref.sourceSnapshotId}:${ref.sourceWorkItemId}:${ref.sourceField}:${ref.quote}`}
                  className="rounded-md border border-border bg-background p-3 text-sm leading-6 text-muted-foreground"
                >
                  <span className="mb-1 block text-xs font-medium text-foreground">
                    Work Item {ref.sourceWorkItemId} · {friendlyCode(ref.sourceField)}
                  </span>
                  “{ref.quote}”
                </blockquote>
              ))}
            </div>
          ) : typeof record.evidence === "string" && record.evidence.trim() ? (
            <p className="mt-2 rounded-md border border-border bg-background p-3 text-sm leading-6 text-muted-foreground">
              {record.evidence}
            </p>
          ) : <p className="mt-2 text-sm text-muted-foreground">No evidence is attached.</p>}
        </div>
      </div>
    </section>
  )
}

function ConflictEvidence({
  participant,
  sources,
  contextLoading,
}: {
  participant: ProjectKnowledgeHardConflictParticipant
  sources: ProjectKnowledgeReviewSource[]
  contextLoading: boolean
}) {
  return (
    <div className="mt-4 border-t border-border pt-3">
      <div className="text-xs font-semibold text-foreground">Source evidence</div>
      {participant.evidenceRefs.length ? (
        <div className="mt-2 space-y-2">
          {participant.evidenceRefs.map((ref, index) => {
            const source = sources.find((candidate) => candidate.sourceSnapshotId === ref.sourceSnapshotId) ??
              sources.find((candidate) => candidate.sourceWorkItemId === ref.sourceWorkItemId)
            const sourceLabel = source
              ? `${source.workItemType} #${source.sourceWorkItemId} — ${source.workItemTitle}`
              : `Work item #${ref.sourceWorkItemId}`
            return (
              <div key={`${ref.sourceWorkItemId}-${ref.sourceField}-${index}`} className="rounded-md border border-border bg-card p-3">
                {source?.workItemUrl ? (
                  <a
                    href={source.workItemUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Open work item ${source.sourceWorkItemId} in Azure DevOps`}
                  >
                    {sourceLabel}<ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
                  </a>
                ) : (
                  <div className="text-sm font-medium text-foreground">{sourceLabel}</div>
                )}
                <div className="mt-1 text-xs text-muted-foreground">{friendlyCode(ref.sourceField)}</div>
                <blockquote className="mt-2 border-l-2 border-primary/40 pl-3 text-sm leading-6 text-muted-foreground">
                  “{ref.quote}”
                </blockquote>
              </div>
            )
          })}
        </div>
      ) : participant.evidence ? (
        <div className="mt-2 rounded-md border border-border bg-card p-3 text-sm leading-6 text-muted-foreground">
          {participant.evidence}
          {participant.sourceWorkItemIds.length ? (
            <div className="mt-2 text-xs">Source {participant.sourceWorkItemIds.map((id) => `#${id}`).join(", ")}</div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 text-sm text-muted-foreground">No evidence was attached to this version.</div>
      )}
      {contextLoading ? (
        <div role="status" className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <RefreshCw className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Loading source details...
        </div>
      ) : null}
    </div>
  )
}

function hardConflictLabel(conflictType: string) {
  if (conflictType === "duplicate_identity") return "Different versions"
  if (conflictType === "incompatible_transition_target") return "Conflicting transition targets"
  if (conflictType === "incompatible_concrete_value") return "Conflicting values"
  return "Knowledge conflict"
}

function reviewCategory(blocker: ProjectKnowledgeDraftBlocker): ProjectKnowledgeReviewCategory {
  return blocker.type === "hard_conflict" ? blocker.affectedCategory : blocker.category
}

function friendlyConflictSubject(subject: string) {
  const identityMatch = subject.match(/^identity:([^:]+):(.+)$/)
  if (identityMatch) {
    return friendlyCode(identityMatch[2])
  }
  return subject.split(":").map(friendlyCode).join(" \u00b7 ")
}

function conflictProjectionKeys(participants: ProjectKnowledgeHardConflictParticipant[]) {
  const keys = Array.from(new Set(participants.flatMap((participant) => Object.keys(participant.projection))))
  const differing = keys.filter((key) => new Set(participants.map((participant) => stableJson(participant.projection[key]))).size > 1)
  return differing.length ? differing : keys
}

function displayConflictValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not specified"
  if (typeof value === "string") return value
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return JSON.stringify(value, null, 2)
}

function singleLineConflictValue(value: unknown) {
  const displayed = displayConflictValue(value).replace(/\s+/g, " ")
  return displayed.length > 100 ? `${displayed.slice(0, 97)}...` : displayed
}

function parseReviewedKnowledge(value: string): { data?: ProjectKnowledgeBase; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    return { error: error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON." }
  }
  const result = ProjectKnowledgeBaseSchema.safeParse(parsed)
  if (result.success) return { data: result.data }
  return {
    error: result.error.issues.map((issue) => {
      const path = issue.path.length ? `${issue.path.join(".")}: ` : ""
      return `${path}${issue.message}`
    }).join("\n"),
  }
}

function withUniqueRenderKeys(blockers: ProjectKnowledgeDraftBlocker[]) {
  const totals = blockers.reduce<Map<string, number>>((counts, blocker) => {
    const identity = `${blocker.entryInstanceId ?? "legacy"}:${blocker.id}`
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
    return counts
  }, new Map())
  const occurrences = new Map<string, number>()
  return blockers.map((blocker) => {
    const identity = `${blocker.entryInstanceId ?? "legacy"}:${blocker.id}`
    const occurrence = (occurrences.get(identity) ?? 0) + 1
    occurrences.set(identity, occurrence)
    return {
      blocker,
      renderKey: (totals.get(identity) ?? 0) > 1 ? `${identity}:render-${occurrence}` : identity,
    }
  })
}

function sourceAvailabilityTitle(
  availability: ProjectKnowledgeReviewContextEntry["sourceAvailability"],
  affectedWorkItemIds: string[],
) {
  const items = affectedWorkItemIds.length
    ? `Work Item${affectedWorkItemIds.length === 1 ? "" : "s"} ${affectedWorkItemIds.join(", ")}`
    : "the affected work item"
  if (availability === "unmatched_work_item") return `No captured source matches ${items}. This entry cannot be verified in the current draft.`
  if (availability === "empty_fields") return `Captured immutable fields are empty for ${items}. This entry cannot be verified in the current draft.`
  if (availability === "available") return `Source details are available for ${items}.`
  return `Source snapshot unavailable for ${items}. This entry cannot be verified in the current draft.`
}

function DefinitionRows({ value }: { value: Record<string, unknown> | null }) {
  if (!value) return <div className="text-xs italic text-muted-foreground">Entry does not exist</div>
  return (
    <dl className="space-y-2 text-xs">
      {Object.entries(value).filter(([, nested]) => nested !== undefined).map(([key, nested]) => (
        <div key={key}>
          <dt className="font-semibold text-foreground">{friendlyCode(key)}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">
            {typeof nested === "string" ? nested : JSON.stringify(nested, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function FilterButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
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

function isEvidenceBlocker(blocker: ProjectKnowledgeDraftBlocker): blocker is ProjectKnowledgeEvidenceBlocker {
  return ["missing_evidence_refs", "quote_mismatch", "snapshot_missing", "work_item_mismatch", "source_field_missing"].includes(blocker.type)
}

function findKnowledgeEntry(
  knowledge: ProjectKnowledgeBase,
  category: ProjectKnowledgeReviewCategory,
  key: string,
  entryInstanceId?: string,
) {
  if (entryInstanceId) {
    const instance = findProjectKnowledgeEntryInstance(knowledge, entryInstanceId)
    if (instance?.category === category) return instance.entry as unknown as Record<string, unknown>
  }
  const target = canonicalKey(key)
  if (category === "module") return knowledge.modules.find((entry) => canonicalKey(entry.id) === target) as Record<string, unknown> | undefined
  if (category === "business_rule") return knowledge.businessRules.find((entry) => canonicalKey(entry.id) === target) as Record<string, unknown> | undefined
  if (category === "state_transition") return knowledge.stateTransitions.find((entry) => canonicalKey(entry.id) === target) as Record<string, unknown> | undefined
  if (category === "glossary") return knowledge.glossary.find((entry) => canonicalKey(entry.term) === target) as Record<string, unknown> | undefined
  if (category === "dependency") return knowledge.crossDependencies.find((entry) => canonicalKey(entry.id) === target) as Record<string, unknown> | undefined
  return undefined
}

function setKnowledgeEntryField(
  knowledge: ProjectKnowledgeBase,
  category: ProjectKnowledgeReviewCategory,
  key: string,
  field: string,
  value: unknown,
  entryInstanceId?: string,
) {
  const next = structuredClone(knowledge)
  const entry = findKnowledgeEntry(next, category, key, entryInstanceId)
  if (!entry) return next
  entry[field] = value
  return ProjectKnowledgeBaseSchema.parse(next)
}

function entryTitle(category: ProjectKnowledgeReviewCategory, entry: Record<string, unknown>) {
  if (category === "business_rule") return String(entry.rule ?? entry.id ?? "Business rule")
  if (category === "state_transition") return String(entry.workflowName ?? entry.id ?? "State transition")
  if (category === "glossary") return String(entry.term ?? "Glossary term")
  if (category === "dependency") return `${String(entry.sourceModule ?? "Source")} → ${String(entry.targetModule ?? "Target")}`
  return String(entry.name ?? entry.id ?? "Knowledge entry")
}

function setEntryEvidenceRefs(
  knowledge: ProjectKnowledgeBase,
  category: ProjectKnowledgeReviewCategory,
  key: string,
  refs: ProjectKnowledgeEvidenceRef[],
  entryInstanceId?: string,
) {
  const next = structuredClone(knowledge)
  const entry = findKnowledgeEntry(next, category, key, entryInstanceId)
  if (!entry) return next
  entry.evidenceRefs = refs
  return ProjectKnowledgeBaseSchema.parse(next)
}

function setKnowledgeEntryValue(
  knowledge: ProjectKnowledgeBase,
  category: ProjectKnowledgeReviewCategory,
  key: string,
  value: Record<string, unknown> | null,
  entryInstanceId?: string,
) {
  const next = structuredClone(knowledge) as ProjectKnowledgeBase
  const target = canonicalKey(key)
  const exactInstance = entryInstanceId ? findProjectKnowledgeEntryInstance(next, entryInstanceId) : null
  const replace = <T extends Record<string, unknown>>(items: T[], itemKey: (item: T) => string) => {
    const exactIndex = exactInstance?.category === category
      ? items.indexOf(exactInstance.entry as unknown as T)
      : -1
    const index = exactIndex >= 0
      ? exactIndex
      : items.findIndex((item) => canonicalKey(itemKey(item)) === target)
    if (value === null) {
      if (index >= 0) items.splice(index, 1)
      return
    }
    if (index >= 0) items[index] = value as T
    else items.push(value as T)
  }
  if (category === "module") replace(next.modules as unknown as Record<string, unknown>[], (entry) => String(entry.id ?? ""))
  if (category === "business_rule") replace(next.businessRules as unknown as Record<string, unknown>[], (entry) => String(entry.id ?? ""))
  if (category === "state_transition") replace(next.stateTransitions as unknown as Record<string, unknown>[], (entry) => String(entry.id ?? ""))
  if (category === "glossary") replace(next.glossary as unknown as Record<string, unknown>[], (entry) => String(entry.term ?? ""))
  if (category === "dependency") replace(next.crossDependencies as unknown as Record<string, unknown>[], (entry) => String(entry.id ?? ""))
  return ProjectKnowledgeBaseSchema.parse(next)
}

function replaceConflictGroup(
  knowledge: ProjectKnowledgeBase,
  blocker: Extract<ProjectKnowledgeDraftBlocker, { type: "hard_conflict" }>,
  replacement: ProjectKnowledgeHardConflictParticipant["entry"],
) {
  const next = structuredClone(knowledge) as ProjectKnowledgeBase
  const entries = knowledgeEntriesForCategory(next, blocker.affectedCategory)
  const conflictIdentities = new Set(blocker.participants.map((participant) =>
    logicalKnowledgeEntryIdentity(blocker.affectedCategory, participant.entry as unknown as Record<string, unknown>)))
  const retained: Record<string, unknown>[] = []
  let insertionIndex = -1

  for (const entry of entries) {
    if (conflictIdentities.has(logicalKnowledgeEntryIdentity(blocker.affectedCategory, entry))) {
      if (insertionIndex < 0) insertionIndex = retained.length
      continue
    }
    retained.push(entry)
  }

  retained.splice(insertionIndex < 0 ? retained.length : insertionIndex, 0, replacement as Record<string, unknown>)
  entries.splice(0, entries.length, ...retained)
  return ProjectKnowledgeBaseSchema.parse(next)
}

function logicalKnowledgeEntryIdentity(
  category: Exclude<ProjectKnowledgeReviewCategory, "hard_conflict">,
  entry: Record<string, unknown>,
) {
  const key = category === "glossary" ? entry.term : entry.id
  return `${category}:${canonicalLogicalIdentity(String(key ?? ""))}`
}

function canonicalLogicalIdentity(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function knowledgeEntriesForCategory(
  knowledge: ProjectKnowledgeBase,
  category: Exclude<ProjectKnowledgeReviewCategory, "hard_conflict">,
) {
  if (category === "module") return knowledge.modules as unknown as Record<string, unknown>[]
  if (category === "business_rule") return knowledge.businessRules as unknown as Record<string, unknown>[]
  if (category === "state_transition") return knowledge.stateTransitions as unknown as Record<string, unknown>[]
  if (category === "glossary") return knowledge.glossary as unknown as Record<string, unknown>[]
  return knowledge.crossDependencies as unknown as Record<string, unknown>[]
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function friendlyCode(value: string) {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (character) => character.toUpperCase())
}

function canonicalKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ")
}
