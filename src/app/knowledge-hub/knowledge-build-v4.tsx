"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Database,
  Eye,
  GitMerge,
  Loader2,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress"
import { ApiError } from "@/components/workflow/api-error"
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle"
import { useLlmLoadingGameSession } from "@/components/workflow/llm-loading-games/use-llm-loading-game-session"
import { ManualLLMFields } from "@/components/workflow/manual-llm-panel"
import { postJson } from "@/components/workflow/post-json"
import type { AiGenerationStatus } from "@/components/workflow/use-ai-generation"
import { WorkflowStepper, type WorkflowStepDefinition } from "@/components/workflow/workflow-stepper"
import { AppErrorCode } from "@/modules/shared/errors/app-error"
import type { ActiveProjectScope } from "@/shared/lib/active-project"
import {
  KnowledgeConflictReview,
  type CompactConflictDecision as ConflictDecision,
  type CompactConflictPage as ConflictPage,
} from "./knowledge-review-workspace"
import {
  KnowledgeCategoryFilterButton,
  KnowledgeEntryCard,
  type KnowledgeCategoryVisualKey,
  type KnowledgeDisplayEntry,
} from "./knowledge-entry-card"

type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled"
type JobOperation = "build"

type KnowledgeOperationResult = NonNullable<JobView["result"]>

type JobView = {
  id: string
  status: JobStatus
  operation: JobOperation
  phase: string
  progress: {
    percent?: number
    completed?: number
    total?: number
    draftId?: string
  }
  result: null | {
    outcome?: "no_changes" | "conflicts_required" | "ready_to_publish" | "published" | "outdated"
    draftId?: string
    conflictCount?: number
    possibleTensionCount?: number
    omittedEntryCount?: number
    omissionReasons?: Record<string, number>
    freshness?: string
    message?: string
  }
  cancellation: { requested: boolean; requestedAt: string | null }
  error: string | null
  createdAt?: string
  updatedAt?: string
}

type EnqueuedJob = { job: JobView; reused: boolean }

type ManualDraft = {
  draftId: string
  mode: "incremental" | "full"
  fallbackReason?: string
  batchCount: number
  batches: Array<{
    batchIndex: number
    batchCount: number
    workItemCount: number
    prompt: string
    carriedForward?: boolean
  }>
}

type Props = {
  scope: ActiveProjectScope
  onPublished: () => Promise<void>
  onActivityChange?: (active: boolean) => void
  sourceIndexReady?: boolean
  sourceIndexLoading?: boolean
  sourceIndexContent?: ReactNode
  generationAvailable?: boolean
  onRefreshAvailability?: () => void
}

type KnowledgeDraftPreviewCategory =
  | "all"
  | "module"
  | "business_rule"
  | "state_transition"
  | "glossary"
  | "dependency"

type KnowledgeDraftPreviewPage = {
  draftId: string
  draftVersion: string
  status: string
  counts: Record<KnowledgeDraftPreviewCategory, number>
  filters: { category: KnowledgeDraftPreviewCategory; query: string }
  page: number
  pageSize: number
  pageCount: number
  total: number
  entries: Array<{
    entryId: string
    category: Exclude<KnowledgeDraftPreviewCategory, "all">
    categoryLabel: string
    badge: string
    title: string
    fields: Array<{ id: string; label: string; value: string }>
    sourceWorkItemIds: string[]
    evidence: Array<{ sourceWorkItemId: string; sourceField: string; quote: string }>
  }>
}

type KnowledgeBuildWorkflowStep = "index" | "generate" | "conflicts" | "review" | "publish"

const PHASE_LABELS: Record<string, string> = {
  queued: "Queued",
  resolving_ai_credentials: "Resolving your AI configuration",
  loading_frozen_sources: "Loading project sources",
  preparing_frozen_build: "Preparing knowledge build",
  compiling_batches: "Compiling source batches",
  validating_citations: "Validating citations",
  conflicts_required: "Knowledge conflicts need decisions",
  loading_validated_batches: "Loading validated external batches",
  applying_decisions: "Applying conflict decisions",
  ready_to_publish: "Ready to publish",
  committing_publication: "Committing reviewed publication",
  completed: "Completed",
}

export function KnowledgeBuildV4({
  scope,
  onPublished,
  onActivityChange,
  sourceIndexReady = true,
  sourceIndexLoading = false,
  sourceIndexContent,
  generationAvailable,
  onRefreshAvailability,
}: Props) {
  const [generationMode, setGenerationMode] = useState<"automatic" | "external">("automatic")
  const [compileMode, setCompileMode] = useState<"incremental" | "full">("incremental")
  const [job, setJob] = useState<JobView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [buildUnavailable, setBuildUnavailable] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [readyDraftId, setReadyDraftId] = useState<string | null>(null)
  const [conflictDraftId, setConflictDraftId] = useState<string | null>(null)
  const [conflictPage, setConflictPage] = useState<ConflictPage | null>(null)
  const [conflictsLoading, setConflictsLoading] = useState(false)
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({})
  const [omissionSummary, setOmissionSummary] = useState<{ count: number; reasons: Record<string, number> } | null>(null)
  const [manualDraft, setManualDraft] = useState<ManualDraft | null>(null)
  const [manualResponses, setManualResponses] = useState<Record<number, string>>({})
  const [validatedManualBatches, setValidatedManualBatches] = useState<Record<number, number>>({})
  const [manualBusy, setManualBusy] = useState(false)
  const [decisionsBusy, setDecisionsBusy] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [draftHadConflicts, setDraftHadConflicts] = useState(false)
  const [workflowPublished, setWorkflowPublished] = useState(false)
  const [clockMs, setClockMs] = useState(() => Date.now())
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden")
  const [pollCycle, setPollCycle] = useState(0)
  const processedJobId = useRef<string | null>(null)
  const loadingGameJobIdRef = useRef<string | null>(null)
  const loadingCompletionJobIdRef = useRef<string | null>(null)
  const pollFailureCountRef = useRef(0)
  const pollImmediatelyRef = useRef(false)

  const storageKey = `itestflow.project-knowledge-job.${scope.workspaceId ?? "workspace"}.${scope.projectId}`
  const activeOperation = job && (job.status === "pending" || job.status === "running") ? job.operation : null
  const buildJobActive = activeOperation === "build"
  const currentManualBatch = manualDraft?.batches.find((batch) => !validatedManualBatches[batch.batchIndex])
    ?? manualDraft?.batches[manualDraft.batches.length - 1]
  const allManualBatchesValidated = Boolean(manualDraft) &&
    Object.keys(validatedManualBatches).length === manualDraft!.batchCount

  const readJob = useCallback(async (jobId: string) => {
    if (!scope.workspaceId) throw new Error("The active project is missing its workspace context.")
    const query = new URLSearchParams({ workspaceId: scope.workspaceId, projectId: scope.projectId })
    const response = await fetch(`/api/context/knowledge/jobs/${encodeURIComponent(jobId)}?${query}`, {
      cache: "no-store",
    })
    const body = await response.json().catch(() => null) as { job?: JobView; error?: string } | null
    if (!response.ok || !body?.job) throw new Error(body?.error ?? "The knowledge build status could not be loaded.")
    return body.job
  }, [scope.projectId, scope.workspaceId])

  const loadConflictPage = useCallback(async (draftId: string, page: number) => {
    setConflictsLoading(true)
    setError(null)
    try {
      const result = await postJson<ConflictPage>(
        `/api/context/knowledge/drafts/${encodeURIComponent(draftId)}/conflicts`,
        { scope, page, pageSize: 50 },
      )
      setConflictPage(result)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Knowledge conflicts could not be loaded.")
    } finally {
      setConflictsLoading(false)
    }
  }, [scope])

  const processKnowledgeResult = useCallback(async (result: KnowledgeOperationResult) => {
    if (typeof result.omittedEntryCount === "number" && result.omittedEntryCount > 0) {
      setOmissionSummary({ count: result.omittedEntryCount, reasons: result.omissionReasons ?? {} })
    }
    if (result.outcome === "conflicts_required" && result.draftId) {
      setReadyDraftId(null)
      setConflictDraftId(result.draftId)
      setDraftHadConflicts(true)
      setWorkflowPublished(false)
      setDecisions({})
      await loadConflictPage(result.draftId, 1)
      return
    }
    if (result.outcome === "ready_to_publish" && result.draftId) {
      const hasPossibleTensions = Number(result.possibleTensionCount ?? 0) > 0
      setConflictDraftId(hasPossibleTensions ? result.draftId : null)
      setConflictPage(null)
      setReadyDraftId(result.draftId)
      setWorkflowPublished(false)
      setNotice("The knowledge draft is ready. Publish will commit exactly what was reviewed.")
      if (hasPossibleTensions) {
        setDecisions({})
        await loadConflictPage(result.draftId, 1)
      }
      return
    }
    if (result.outcome === "no_changes") {
      setNotice("No source-backed knowledge changes were found.")
      setReadyDraftId(null)
      setDraftHadConflicts(false)
      setWorkflowPublished(false)
      return
    }
    if (result.outcome === "outdated") {
      setReadyDraftId(null)
      setWorkflowPublished(false)
      setNotice(result.message ?? "Another administrator published first. Start a new build from the latest publication.")
      await onPublished()
      return
    }
    if (result.outcome === "published") {
      setReadyDraftId(null)
      setConflictDraftId(null)
      setConflictPage(null)
      setWorkflowPublished(true)
      setNotice(result.message ?? "Published the exact reviewed draft.")
      await onPublished()
    }
  }, [loadConflictPage, onPublished])

  const processCompletedJob = useCallback(async (completed: JobView) => {
    if (processedJobId.current === completed.id) return
    processedJobId.current = completed.id
    window.localStorage.removeItem(storageKey)
    onActivityChange?.(false)
    if (completed.status === "failed") {
      setError(completed.error ?? "The knowledge build failed.")
      return
    }
    if (completed.status === "cancelled") {
      setNotice("The knowledge build was cancelled.")
      return
    }
    if (completed.result) await processKnowledgeResult(completed.result)
  }, [onActivityChange, processKnowledgeResult, storageKey])

  const loadingGame = useLlmLoadingGameSession<JobView>((completed) => {
    void processCompletedJob(completed)
  })
  const startLoadingGameSession = loadingGame.startSession
  const completeLoadingGameSession = loadingGame.completeSession
  const endLoadingGameSession = loadingGame.endSession

  const beginBuildLoadingExperience = useCallback((next: JobView) => {
    if (next.operation !== "build" || (next.status !== "pending" && next.status !== "running")) return
    if (loadingGameJobIdRef.current === next.id) return
    loadingGameJobIdRef.current = next.id
    loadingCompletionJobIdRef.current = null
    startLoadingGameSession()
  }, [startLoadingGameSession])

  useEffect(() => {
    processedJobId.current = null
    loadingGameJobIdRef.current = null
    loadingCompletionJobIdRef.current = null
    pollFailureCountRef.current = 0
    pollImmediatelyRef.current = false
    endLoadingGameSession()
    setJob(null)
    setError(null)
    setNotice(null)
    setReadyDraftId(null)
    setConflictDraftId(null)
    setConflictPage(null)
    setDecisions({})
    setDraftHadConflicts(false)
    setWorkflowPublished(false)
    const savedJobId = window.localStorage.getItem(storageKey)
    if (!savedJobId) return
    void readJob(savedJobId)
      .then((savedJob) => {
        beginBuildLoadingExperience(savedJob)
        setJob(savedJob)
      })
      .catch(() => window.localStorage.removeItem(storageKey))
  }, [beginBuildLoadingExperience, endLoadingGameSession, readJob, storageKey])

  useEffect(() => {
    const onVisibilityChange = () => {
      const visible = document.visibilityState !== "hidden"
      if (visible) {
        pollImmediatelyRef.current = true
        setPollCycle((cycle) => cycle + 1)
      }
      setPageVisible(visible)
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
  }, [])

  useEffect(() => {
    if (!job) return
    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      if (job.operation === "build" && job.status === "completed") {
        if (loadingCompletionJobIdRef.current === job.id) return
        loadingCompletionJobIdRef.current = job.id
        completeLoadingGameSession(job)
        return
      }
      if (job.operation === "build") {
        loadingGameJobIdRef.current = null
        endLoadingGameSession()
      }
      void processCompletedJob(job)
      return
    }
    if (!pageVisible) return
    const delay = pollImmediatelyRef.current
      ? 0
      : buildJobPollDelay(job, pollFailureCountRef.current, Date.now())
    pollImmediatelyRef.current = false
    const timeout = window.setTimeout(() => {
      void readJob(job.id)
        .then((next) => {
          pollFailureCountRef.current = 0
          setError(null)
          setJob(next)
        })
        .catch((pollError) => {
          pollFailureCountRef.current += 1
          setError(pollError instanceof Error ? pollError.message : "The knowledge build status could not be refreshed.")
          setPollCycle((cycle) => cycle + 1)
        })
    }, delay)
    return () => window.clearTimeout(timeout)
  }, [completeLoadingGameSession, endLoadingGameSession, job, pageVisible, pollCycle, processCompletedJob, readJob])

  useEffect(() => {
    if (!buildJobActive) return
    setClockMs(Date.now())
    const interval = window.setInterval(() => setClockMs(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [buildJobActive, job?.id])

  function activateJob(next: JobView) {
    processedJobId.current = null
    loadingCompletionJobIdRef.current = null
    beginBuildLoadingExperience(next)
    setJob(next)
    setError(null)
    setBuildUnavailable(false)
    setNotice(null)
    window.localStorage.setItem(storageKey, next.id)
    onActivityChange?.(true)
  }

  async function queueBuild() {
    const result = await postJson<EnqueuedJob>("/api/context/knowledge/jobs", {
      scope,
      operation: "build",
      mode: compileMode,
    })
    activateJob(result.job)
  }

  async function startAutomaticBuild() {
    setReadyDraftId(null)
    setConflictDraftId(null)
    setConflictPage(null)
    setDecisions({})
    setOmissionSummary(null)
    setDraftHadConflicts(false)
    setWorkflowPublished(false)
    try {
      await queueBuild()
    } catch (queueError) {
      if (queueError instanceof ApiError
        && (queueError.code === AppErrorCode.KnowledgeBuildUnavailable
          || (queueError.code === undefined && queueError.status === 503))) {
        setBuildUnavailable(true)
        setError(null)
        return
      }
      setBuildUnavailable(false)
      setError(queueError instanceof Error ? queueError.message : "The knowledge build could not start.")
    }
  }

  async function cancelJob() {
    if (!job || !scope.workspaceId) return
    try {
      const query = new URLSearchParams({ workspaceId: scope.workspaceId, projectId: scope.projectId })
      const response = await fetch(`/api/context/knowledge/jobs/${encodeURIComponent(job.id)}?${query}`, {
        method: "DELETE",
      })
      const body = await response.json() as { job?: JobView; error?: string }
      if (!response.ok || !body.job) throw new Error(body.error ?? "Cancellation could not be requested.")
      setJob(body.job)
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Cancellation could not be requested.")
    }
  }

  async function applyDecisions() {
    if (!conflictDraftId || !conflictPage) return
    setDecisionsBusy(true)
    setError(null)
    onActivityChange?.(true)
    try {
      const result = await postJson<KnowledgeOperationResult>(
        `/api/context/knowledge/drafts/${encodeURIComponent(conflictDraftId)}/decisions`,
        {
          scope,
          draftVersion: conflictPage.draftVersion,
          decisions: Object.values(decisions),
        },
      )
      await processKnowledgeResult(result)
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : "Conflict decisions could not be applied.")
    } finally {
      setDecisionsBusy(false)
      onActivityChange?.(false)
    }
  }

  async function publish() {
    if (!readyDraftId) return
    setPublishing(true)
    setError(null)
    onActivityChange?.(true)
    try {
      const result = await postJson<KnowledgeOperationResult>(
        `/api/context/knowledge/drafts/${encodeURIComponent(readyDraftId)}/publish`,
        { scope },
      )
      await processKnowledgeResult(result)
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Project knowledge could not be published.")
    } finally {
      setPublishing(false)
      onActivityChange?.(false)
    }
  }

  async function prepareExternalDraft() {
    setManualBusy(true)
    setError(null)
    setReadyDraftId(null)
    setConflictDraftId(null)
    setDraftHadConflicts(false)
    setWorkflowPublished(false)
    try {
      const draft = await postJson<ManualDraft>("/api/context/knowledge/manual/draft", { scope, mode: compileMode })
      setManualDraft(draft)
      setManualResponses({})
      setValidatedManualBatches({})
      onActivityChange?.(true)
    } catch (prepareError) {
      setError(prepareError instanceof Error ? prepareError.message : "The external prompt could not be prepared.")
    } finally {
      setManualBusy(false)
    }
  }

  async function validateExternalBatch() {
    if (!manualDraft || !currentManualBatch) return
    const rawOutput = manualResponses[currentManualBatch.batchIndex]?.trim()
    if (!rawOutput) return
    setManualBusy(true)
    setError(null)
    try {
      const result = await postJson<{ validated: true; batchIndex: number; entryCount: number }>(
        "/api/context/knowledge/manual/validate",
        {
          scope,
          draftId: manualDraft.draftId,
          batchIndex: currentManualBatch.batchIndex,
          rawOutput,
        },
      )
      setValidatedManualBatches((current) => ({ ...current, [result.batchIndex]: result.entryCount }))
    } catch (validationError) {
      setError(validationError instanceof Error ? validationError.message : "The external response could not be validated.")
    } finally {
      setManualBusy(false)
    }
  }

  async function finalizeExternalDraft() {
    if (!manualDraft) return
    setManualBusy(true)
    setError(null)
    try {
      const result = await postJson<KnowledgeOperationResult>("/api/context/knowledge/manual/finalize", {
        scope,
        mode: compileMode,
        draftId: manualDraft.draftId,
      })
      await processKnowledgeResult(result)
      onActivityChange?.(false)
    } catch (finalizeError) {
      setError(finalizeError instanceof Error ? finalizeError.message : "External results could not be finalized.")
    } finally {
      setManualBusy(false)
    }
  }

  const hasGeneratedDraft = Boolean(conflictDraftId || readyDraftId || workflowPublished)
  const workflowSteps: WorkflowStepDefinition<KnowledgeBuildWorkflowStep>[] = [
    {
      id: "index",
      label: "Load Project Index",
      shortLabel: "Load Index",
      description: "Sync and inspect the selected Azure DevOps source work items.",
      icon: Database,
    },
    {
      id: "generate",
      label: "Generate Knowledge Draft",
      shortLabel: "Generate",
      description: "Compile a grounded draft from the loaded source index.",
      icon: Sparkles,
    },
    ...(draftHadConflicts ? [{
      id: "conflicts" as const,
      label: "Resolve Conflicts",
      shortLabel: "Conflicts",
      description: "Choose or combine supported versions for genuine semantic conflicts.",
      icon: GitMerge,
    }] : []),
    {
      id: "review",
      label: "Review Knowledge Draft",
      shortLabel: "Review",
      description: "Inspect the exact source-backed draft before publication.",
      icon: Eye,
    },
    {
      id: "publish",
      label: "Publish",
      description: "Commit the exact reviewed draft.",
      icon: ShieldCheck,
    },
  ]
  const activeWorkflowStep: KnowledgeBuildWorkflowStep =
    !sourceIndexReady || sourceIndexLoading
      ? "index"
      : publishing || workflowPublished
        ? "publish"
        : conflictDraftId && draftHadConflicts
          ? "conflicts"
          : readyDraftId
            ? "review"
            : "generate"
  const completedWorkflowSteps: KnowledgeBuildWorkflowStep[] = []
  if (sourceIndexReady) completedWorkflowSteps.push("index")
  if (hasGeneratedDraft) completedWorkflowSteps.push("generate")
  if (draftHadConflicts && (readyDraftId || publishing || workflowPublished)) {
    completedWorkflowSteps.push("conflicts")
  }
  if (publishing || workflowPublished) completedWorkflowSteps.push("review")
  if (workflowPublished) completedWorkflowSteps.push("publish")

  return (
    <div className="space-y-4">
      <WorkflowStepper
        steps={workflowSteps}
        activeStepId={activeWorkflowStep}
        completedStepIds={completedWorkflowSteps}
        enabledStepIds={[activeWorkflowStep]}
        ariaLabel="Build Knowledge workflow"
        className="rounded-md border border-border bg-card p-3"
      />

      {sourceIndexContent}

      <Card className="qa-card overflow-hidden">
        <CardHeader className="border-b border-border">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <CardTitle className="text-base">Build Knowledge</CardTitle>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                Generate a grounded knowledge draft. Evidence is linked automatically; only genuine knowledge conflicts require review.
              </p>
            </div>
            <GenerationModeToggle
              mode={generationMode === "automatic" ? "auto" : "manual"}
              onChange={(mode) => setGenerationMode(mode === "auto" ? "automatic" : "external")}
              ariaLabel="Knowledge build mode"
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="rounded-md border border-border bg-card p-4">
            <Label className="text-sm font-semibold text-foreground">Compile mode</Label>
            <div className="mt-2 grid gap-2 rounded-md border border-border bg-muted p-1 sm:grid-cols-2">
              <button
                type="button"
                aria-pressed={compileMode === "incremental"}
                disabled={Boolean(activeOperation) || manualBusy || sourceIndexLoading}
                className={`min-h-11 rounded-md border px-3 py-2 text-sm font-semibold outline-none transition-colors duration-ui focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
                  compileMode === "incremental"
                    ? "border-primary bg-accent text-primary shadow-sm"
                    : "border-transparent bg-card text-foreground hover:border-primary/40 hover:bg-accent"
                }`}
                onClick={() => setCompileMode("incremental")}
              >
                Incremental
              </button>
              <button
                type="button"
                aria-pressed={compileMode === "full"}
                disabled={Boolean(activeOperation) || manualBusy || sourceIndexLoading}
                className={`min-h-11 rounded-md border px-3 py-2 text-sm font-semibold outline-none transition-colors duration-ui focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${
                  compileMode === "full"
                    ? "border-primary bg-accent text-primary shadow-sm"
                    : "border-transparent bg-card text-foreground hover:border-primary/40 hover:bg-accent"
                }`}
                onClick={() => setCompileMode("full")}
              >
                Full recompile
              </button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              {compileMode === "incremental"
                ? "Use source work items changed since the last published knowledge build."
                : "Rebuild knowledge from all active source work items."}
            </p>
          </div>

          <Tabs value={generationMode}>
            <TabsContent value="automatic" className="mt-5">
              {generationAvailable === false ? (
                <div role="status" className="mb-4 flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div>
                      <div className="font-semibold">Generation service offline</div>
                      <p className="mt-1 text-xs leading-5">
                        Automatic builds are rejected while no generation worker is healthy.
                        Start the app with <code>npm run dev</code> (web and worker together), or run{" "}
                        <code>npm run worker:dev</code> alongside <code>npm run web:dev</code>.
                      </p>
                    </div>
                  </div>
                  {onRefreshAvailability ? (
                    <Button size="sm" variant="outline" onClick={onRefreshAvailability}>
                      Check again
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <section
                aria-labelledby="automatic-knowledge-build-title"
                className="rounded-md border border-border bg-card p-4"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <h3 id="automatic-knowledge-build-title" className="text-sm font-semibold">Generate knowledge draft</h3>
                    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                      The AI builds knowledge from the current sources. Source updates made after it starts will be included in the next build.
                    </p>
                    {!sourceIndexReady && !activeOperation ? (
                      <p role="status" className="mt-2 text-xs text-muted-foreground">
                        Load the project index above before building knowledge.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="min-h-11 shrink-0 sm:min-w-40"
                    onClick={() => void startAutomaticBuild()}
                    disabled={!sourceIndexReady || sourceIndexLoading || generationAvailable === false || Boolean(activeOperation) || decisionsBusy || publishing}
                    title={generationAvailable === false ? "The generation service is not running." : undefined}
                  >
                    {activeOperation === "build" ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
                    {activeOperation === "build" ? "Building…" : "Build knowledge"}
                  </Button>
                </div>
              </section>
            </TabsContent>
            <TabsContent value="external" className="mt-5 space-y-4">
              <section
                aria-labelledby="external-knowledge-build-title"
                className="rounded-md border border-border bg-card p-4"
              >
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <h3 id="external-knowledge-build-title" className="text-sm font-semibold">Use an external LLM</h3>
                    <p className="mt-1 text-sm leading-6 text-muted-foreground">The same citation handles and server validator apply; unsupported entries are omitted.</p>
                    {!sourceIndexReady && !activeOperation ? (
                      <p role="status" className="mt-2 text-xs text-muted-foreground">
                        Load the project index above before preparing an external prompt.
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="outline"
                    className="min-h-11 shrink-0"
                    onClick={() => void prepareExternalDraft()}
                    disabled={!sourceIndexReady || sourceIndexLoading || manualBusy || Boolean(activeOperation) || decisionsBusy || publishing}
                  >
                    {manualBusy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                    Prepare prompt
                  </Button>
                </div>
              </section>
              {manualDraft?.fallbackReason ? <p className="text-sm text-muted-foreground">{manualDraft.fallbackReason}</p> : null}
              {manualDraft && manualDraft.batchCount === 0 ? (
                <div role="status" className="rounded-md border border-border bg-muted/30 p-4 text-sm">No changed source batches require an external prompt.</div>
              ) : null}
              {manualDraft && currentManualBatch && !allManualBatchesValidated ? (
                <div className="space-y-3 border-t border-border pt-4">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">Batch {currentManualBatch.batchIndex} of {manualDraft.batchCount}</span>
                    <span className="text-muted-foreground">{Object.keys(validatedManualBatches).length} validated</span>
                  </div>
                  <ManualLLMFields
                    prompt={currentManualBatch.prompt}
                    response={manualResponses[currentManualBatch.batchIndex] ?? ""}
                    onResponseChange={(value) => setManualResponses((current) => ({ ...current, [currentManualBatch.batchIndex]: value }))}
                    onSubmit={validateExternalBatch}
                    submitting={manualBusy}
                    submitLabel="Validate batch"
                    submittingLabel="Validating…"
                    responseLabel="External LLM response"
                    responsePlaceholder="Paste the JSON response for this batch."
                    promptMinHeightClass="min-h-[260px]"
                    responseMinHeightClass="min-h-[200px]"
                  />
                </div>
              ) : null}
              {manualDraft && (allManualBatchesValidated || manualDraft.batchCount === 0) ? (
                <div className="flex justify-end border-t border-border pt-4">
                  <Button className="min-h-11" onClick={() => void finalizeExternalDraft()} disabled={manualBusy || Boolean(activeOperation)}>
                    {manualBusy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
                    {manualBusy ? "Finalizing…" : "Finalize grounded draft"}
                  </Button>
                </div>
              ) : null}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {job?.operation === "build" && (
        job.status === "pending" ||
        job.status === "running" ||
        (job.status === "completed" && loadingGame.shouldKeepPanelMounted)
      ) ? (
        <AiGenerationProgress
          variant="generic"
          title="Building project knowledge"
          status={aiStatusForBuildJob(job)}
          description={buildJobProgressDescription(job)}
          currentStepLabel={jobPhaseLabel(job)}
          elapsedSeconds={jobElapsedSeconds(job, clockMs)}
          canCancel={buildJobActive && !job.cancellation.requested}
          onCancel={() => void cancelJob()}
          loadingGame={loadingGame.panel}
          activeHint="You can leave or refresh this page; generation will continue safely."
        />
      ) : job && (job.status === "pending" || job.status === "running") ? (
        <JobProgress job={job} onCancel={cancelJob} />
      ) : null}

      {buildUnavailable ? (
        <div role="alert" className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div>
              <div className="font-semibold">Generation service unavailable</div>
              <p className="mt-1 text-xs leading-5">
                The background generation service is not running, so the build was not queued.
                Start the app with <code>npm run dev</code> (web and worker together), or run{" "}
                <code>npm run worker:dev</code> alongside <code>npm run web:dev</code>, then retry.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void startAutomaticBuild()}
            disabled={Boolean(activeOperation)}
          >
            Retry build
          </Button>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {notice ? (
        <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-4 text-sm">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      ) : null}

      {omissionSummary ? <OmissionSummary summary={omissionSummary} /> : null}

      {conflictDraftId ? (
        <KnowledgeConflictReview
          page={conflictPage}
          loading={conflictsLoading}
          decisions={decisions}
          active={decisionsBusy}
          onDecision={(decision) => setDecisions((current) => ({ ...current, [decision.conflictId]: decision }))}
          onPage={(page) => void loadConflictPage(conflictDraftId, page)}
          onReset={() => setDecisions({})}
          onApply={() => void applyDecisions()}
        />
      ) : null}

      {readyDraftId ? (
        <KnowledgeDraftPreview
          key={readyDraftId}
          scope={scope}
          draftId={readyDraftId}
          publishing={publishing}
          publishDisabled={Boolean(activeOperation)}
          onPublish={() => void publish()}
        />
      ) : null}
    </div>
  )
}

const DRAFT_PREVIEW_CATEGORIES: Array<{
  key: KnowledgeDraftPreviewCategory
  label: string
  iconKey: KnowledgeCategoryVisualKey
}> = [
  { key: "all", label: "All", iconKey: "all" },
  { key: "module", label: "Modules", iconKey: "module" },
  { key: "business_rule", label: "Business Rules", iconKey: "businessRule" },
  { key: "state_transition", label: "State Transitions", iconKey: "stateTransition" },
  { key: "glossary", label: "Glossary", iconKey: "glossary" },
  { key: "dependency", label: "Dependencies", iconKey: "dependency" },
]

function KnowledgeDraftPreview({
  scope,
  draftId,
  publishing,
  publishDisabled,
  onPublish,
}: {
  scope: ActiveProjectScope
  draftId: string
  publishing: boolean
  publishDisabled: boolean
  onPublish: () => void
}) {
  const [category, setCategory] = useState<KnowledgeDraftPreviewCategory>("all")
  const [queryInput, setQueryInput] = useState("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const [preview, setPreview] = useState<KnowledgeDraftPreviewPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    void postJson<KnowledgeDraftPreviewPage>(
      `/api/context/knowledge/drafts/${encodeURIComponent(draftId)}/preview`,
      { scope, category, query, page, pageSize: 10 },
      controller.signal,
    )
      .then((result) => {
        setPreview(result)
        if (result.page !== page) setPage(result.page)
      })
      .catch((previewError) => {
        if (controller.signal.aborted) return
        setError(previewError instanceof Error ? previewError.message : "The knowledge draft preview could not be loaded.")
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [category, draftId, page, query, reload, scope])

  const entries = preview?.entries.map(toKnowledgeDisplayEntry) ?? []
  const showingStart = preview && preview.total > 0 ? (preview.page - 1) * preview.pageSize + 1 : 0
  const showingEnd = preview ? Math.min(preview.page * preview.pageSize, preview.total) : 0

  return (
    <Card className="qa-card min-w-0 max-w-full overflow-hidden">
      <CardHeader className="border-b border-border">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-2xl">
            <CardTitle
              id="knowledge-draft-preview-title"
              role="heading"
              aria-level={2}
              className="text-base"
            >
              Review Knowledge Draft
            </CardTitle>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Inspect the exact grounded entries and verified evidence that will be committed. This preview is read-only.
            </p>
          </div>
          <Badge variant="outline" className="w-fit tabular-nums">
            {preview?.counts.all ?? "—"} entries
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="min-w-0 max-w-full space-y-5 pt-5">
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-center"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            setPage(1)
            const nextQuery = queryInput.trim()
            if (nextQuery === query) setReload((current) => current + 1)
            else setQuery(nextQuery)
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" aria-hidden="true" />
            <Input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              className="min-h-11 pl-9"
              placeholder="Search this draft or source work item IDs"
              aria-label="Search knowledge draft"
              maxLength={200}
            />
          </div>
          <Button type="submit" variant="outline" className="min-h-11" disabled={loading && !preview}>
            Search
          </Button>
          {query ? (
            <Button
              type="button"
              variant="ghost"
              className="min-h-11"
              onClick={() => {
                setQueryInput("")
                setQuery("")
                setPage(1)
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>

        {error ? (
          <div role="alert" className="flex flex-col gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
            <span>{error}</span>
            <Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => setReload((current) => current + 1)}>
              Retry preview
            </Button>
          </div>
        ) : null}

        <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[216px_minmax(0,1fr)]">
          <div role="group" aria-label="Draft knowledge categories" className="flex min-w-0 max-w-full flex-wrap gap-1 lg:block lg:space-y-1">
            {DRAFT_PREVIEW_CATEGORIES.map((item) => (
              <KnowledgeCategoryFilterButton
                key={item.key}
                label={item.label}
                iconKey={item.iconKey}
                count={preview?.counts[item.key] ?? 0}
                active={category === item.key}
                onClick={() => {
                  setCategory(item.key)
                  setPage(1)
                }}
              />
            ))}
          </div>

          <div
            role="region"
            aria-labelledby="knowledge-draft-preview-title"
            aria-busy={loading}
            tabIndex={0}
            className="min-h-52 min-w-0 max-w-full space-y-3 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {loading && !preview ? (
              <div aria-label="Loading knowledge draft preview" className="space-y-3">
                {Array.from({ length: 3 }, (_, index) => (
                  <div key={index} className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Skeleton className="h-5 w-16 rounded-full" />
                        <Skeleton className="h-4 w-2/5" />
                      </div>
                      <Skeleton className="mt-2 h-3 w-3/5" />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Skeleton className="h-5 w-16 rounded-full" />
                      <Skeleton className="h-5 w-24 rounded-full" />
                      <Skeleton className="size-5 rounded-sm" />
                    </div>
                  </div>
                ))}
              </div>
            ) : entries.length ? (
              entries.map((entry) => <KnowledgeEntryCard key={entry.key} entry={entry} />)
            ) : !error ? (
              <div className="rounded-md border border-border bg-muted/30 p-6 text-center">
                <div className="text-sm font-semibold text-foreground">No draft entries match</div>
                <p className="mt-1 text-sm text-muted-foreground">Clear the search or choose another category.</p>
              </div>
            ) : null}

            {preview && preview.pageCount > 1 ? (
              <div className="flex flex-col gap-3 border-t border-border pt-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span className="tabular-nums">Showing {showingStart}-{showingEnd} of {preview.total}</span>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    disabled={loading || preview.page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                  >
                    <ChevronLeft className="size-4" aria-hidden="true" />
                    Previous
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11"
                    disabled={loading || preview.page >= preview.pageCount}
                    onClick={() => setPage((current) => Math.min(preview.pageCount, current + 1))}
                  >
                    Next
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-xs leading-5 text-muted-foreground">
            Publish commits this exact reviewed draft. It does not reload sources, call AI, merge another publication, or change these entries.
          </p>
          <Button
            className="min-h-11 shrink-0 sm:min-w-40"
            onClick={onPublish}
            disabled={publishing || publishDisabled || !preview || loading}
            aria-busy={publishing}
          >
            {publishing ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck className="size-4" aria-hidden="true" />}
            {publishing ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function toKnowledgeDisplayEntry(
  entry: KnowledgeDraftPreviewPage["entries"][number],
): KnowledgeDisplayEntry {
  const summary = knowledgeDraftPreviewSummary(entry)

  return {
    key: entry.entryId,
    highlightIdentity: entry.entryId,
    category: entry.category,
    categoryLabel: entry.categoryLabel,
    badge: entry.badge,
    title: entry.title,
    description: summary.description,
    evidence: entry.evidence.map((item) => item.quote).join(" | "),
    sourceWorkItemIds: entry.sourceWorkItemIds,
    meta: summary.meta,
    searchText: "",
    details: entry.fields,
    evidenceItems: entry.evidence,
  }
}

function knowledgeDraftPreviewSummary(
  entry: KnowledgeDraftPreviewPage["entries"][number],
): Pick<KnowledgeDisplayEntry, "description" | "meta"> {
  const fieldValue = (id: string) => entry.fields.find((field) => field.id === id)?.value.trim() ?? ""
  const meta = (...values: string[]) => values.filter((value) => Boolean(value))

  switch (entry.category) {
    case "module":
      return { description: fieldValue("description"), meta: [] }
    case "business_rule":
      return {
        description: "",
        meta: meta(fieldValue("moduleName"), fieldValue("sourceField")),
      }
    case "state_transition":
      return {
        description: fieldValue("triggerOrCondition"),
        meta: meta(
          fieldValue("moduleName"),
          fieldValue("actor") ? `Actor: ${fieldValue("actor")}` : "",
        ),
      }
    case "glossary":
      return {
        description: fieldValue("definition"),
        meta: meta(fieldValue("type").replace(/_/g, " ")),
      }
    case "dependency":
      return {
        description: fieldValue("description"),
        meta: meta(fieldValue("dependencyType")),
      }
  }
}

function jobPhaseLabel(job: JobView) {
  return PHASE_LABELS[job.phase] ?? job.phase.replace(/_/g, " ")
}

function aiStatusForBuildJob(job: JobView): AiGenerationStatus {
  if (job.status === "completed") return "completed"
  if (job.status === "failed") return "failed"
  if (job.status === "cancelled") return "cancelled"
  if (["queued", "loading_frozen_sources"].includes(job.phase)) return "preparing_context"
  if (["resolving_ai_credentials", "preparing_frozen_build"].includes(job.phase)) return "building_prompt"
  if (job.phase === "validating_citations") return "validating_response"
  if (job.phase === "compiling_batches") return "waiting_llm"
  return job.status === "pending" ? "preparing_context" : "waiting_llm"
}

function buildJobProgressDescription(job: JobView) {
  if (job.cancellation.requested) return "Stopping the build."
  if (job.phase === "queued") return "Starting the project knowledge build."

  const label = jobPhaseLabel(job)
  const batch = job.progress.total
    ? ` Batch ${job.progress.completed ?? 0} of ${job.progress.total}.`
    : ""
  return `${label}.${batch}`
}

function jobElapsedSeconds(job: JobView, nowMs: number) {
  if (!job.createdAt) return undefined
  const startedMs = Date.parse(job.createdAt)
  if (!Number.isFinite(startedMs)) return undefined
  return Math.max(0, Math.floor((nowMs - startedMs) / 1000))
}

export function buildJobPollDelay(
  job: Pick<JobView, "createdAt">,
  consecutiveFailures: number,
  nowMs: number,
) {
  if (consecutiveFailures > 0) {
    return [5_000, 15_000, 30_000][Math.min(consecutiveFailures - 1, 2)]
  }
  const createdAt = job.createdAt ? Date.parse(job.createdAt) : nowMs
  const ageMs = Number.isFinite(createdAt) ? Math.max(0, nowMs - createdAt) : 0
  if (ageMs < 15_000) return 2_000
  if (ageMs < 120_000) return 5_000
  return 15_000
}

function JobProgress({ job, onCancel }: { job: JobView; onCancel: () => Promise<void> }) {
  const percent = typeof job.progress.percent === "number" ? job.progress.percent : undefined
  const label = PHASE_LABELS[job.phase] ?? job.phase.replace(/_/g, " ")
  return (
    <div role="status" aria-live="polite" className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
            {label}
          </div>
          {job.progress.total ? (
            <p className="mt-1 text-xs text-muted-foreground">Batch {job.progress.completed ?? 0} of {job.progress.total}</p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" className="min-h-10" onClick={() => void onCancel()} disabled={job.cancellation.requested}>
          <CircleStop className="size-4" aria-hidden="true" />
          {job.cancellation.requested ? "Cancelling…" : "Cancel"}
        </Button>
      </div>
      {percent === undefined ? (
        <div className="relative h-1 overflow-hidden rounded-full bg-primary/15" role="progressbar" aria-label={`${label} in progress`}>
          <div className="absolute inset-y-0 w-1/3 animate-[itf-indeterminate_1.15s_ease-in-out_infinite] bg-primary motion-reduce:left-0 motion-reduce:w-full motion-reduce:animate-none" />
        </div>
      ) : (
        <Progress value={percent} aria-label={`${label}: ${percent}%`} />
      )}
      <p className="text-xs text-muted-foreground">You can leave or refresh this page; this operation will continue safely.</p>
    </div>
  )
}

function OmissionSummary({ summary }: { summary: { count: number; reasons: Record<string, number> } }) {
  return (
    <div role="status" className="rounded-md border border-warning/30 bg-warning/10 p-4 text-sm">
      <div className="font-semibold">{summary.count} unsupported {summary.count === 1 ? "entry was" : "entries were"} omitted</div>
      <p className="mt-1 text-muted-foreground">This is non-blocking. Entry-level details remain in the audit log.</p>
      {Object.keys(summary.reasons).length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {Object.entries(summary.reasons).map(([reason, count]) => (
            <li key={reason}>{formatLabel(reason)}: {count}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function formatLabel(value: string) {
  return value.replace(/^identity:/, "").replace(/[_:-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
}
