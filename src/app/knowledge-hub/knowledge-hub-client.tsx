"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { DashboardEmptyPanel } from "@/components/dashboard/dashboard-states"
import {
  AlertTriangle,
  ArrowUpDown,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  Download,
  History,
  RefreshCw,
  Save,
  Search,
  SearchX,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContextFilterSelector } from "@/components/domain/context-filter-selector"
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle"
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress"
import { AiGenerationCompletedMetrics } from "@/components/workflow/ai-generation-metrics"
import { patchJson, postJson } from "@/components/workflow/post-json"
import { ManualLLMFields } from "@/components/workflow/manual-llm-panel"
import { WorkflowStepper } from "@/components/workflow/workflow-stepper"
import { useAiGeneration } from "@/components/workflow/use-ai-generation"
import { useLlmLoadingGameSession } from "@/components/workflow/llm-loading-games/use-llm-loading-game-session"
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  DEFAULT_CONTEXT_STATES,
  DEFAULT_CONTEXT_WORK_ITEM_TYPES,
} from "@/lib/project-context-defaults"
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project"
import type { TokenUsage } from "@/modules/llm/llm-types"
import type { ProjectKnowledgeEvidenceRef } from "@/modules/rag/project-knowledge.schema"
import type {
  ProjectKnowledgeDraftBlocker,
  ProjectKnowledgeReviewContext,
  ProjectKnowledgeReviewSummary,
} from "@/modules/rag/project-knowledge-review.contracts"
import { KnowledgeReviewWorkspace } from "./knowledge-review-workspace"
import {
  projectScopeKey,
  selectAvailableDefaults,
  useProjectWorkItemMetadata,
} from "@/shared/lib/use-project-work-item-metadata"

type IndexResult = {
  mode: "incremental" | "rebuild"
  fetchedCount: number
  storedWorkItemCount: number
  indexedWorkItemCount: number
  indexedChunkCount: number
  createdCount: number
  updatedCount: number
  unchangedCount: number
  inactiveCount: number
  skippedEmptyCount: number
  workItemTypes: string[]
  states: string[]
}

type RecentContextItem = {
  workItemId: string
  workItemType: string
  title: string
  state?: string | null
  syncStatus?: string | null
  updatedDate?: string | null
  lastIndexedAt?: string | null
  chunkCount: number
}

type ContextSortBy = "lastIndexedAt" | "type" | "state"
type ContextSortDirection = "asc" | "desc"

type ContextStatusResult = {
  items: RecentContextItem[]
  totalCount: number
  page: number
  pageSize: number
  totalPages: number
  sortBy: ContextSortBy
  sortDirection: ContextSortDirection
  query?: string
}

type KnowledgeCompileMode = "incremental" | "full"

type KnowledgeSource = {
  sourceWorkItemIds: string[]
  evidence: string
  evidenceRefs?: ProjectKnowledgeEvidenceRef[]
}

type ProjectKnowledgeModule = KnowledgeSource & {
  id: string
  name: string
  description: string
}

type ProjectKnowledgeBusinessRule = KnowledgeSource & {
  id: string
  rule: string
  sourceField: string
  moduleName?: string
}

type ProjectKnowledgeStateTransition = KnowledgeSource & {
  id: string
  workflowName: string
  fromState?: string
  toState?: string
  triggerOrCondition: string
  actor?: string
  moduleName?: string
}

type ProjectKnowledgeGlossaryTerm = KnowledgeSource & {
  term: string
  type?: "term" | "actor" | "role" | "system" | "external_service" | "business_entity" | "data_entity" | "process"
  definition: string
}

type ProjectKnowledgeCrossDependency = KnowledgeSource & {
  id: string
  sourceModule: string
  targetModule: string
  dependencyType: string
  description: string
}

type ProjectKnowledgeBase = {
  modules: ProjectKnowledgeModule[]
  businessRules: ProjectKnowledgeBusinessRule[]
  stateTransitions: ProjectKnowledgeStateTransition[]
  glossary: ProjectKnowledgeGlossaryTerm[]
  crossDependencies: ProjectKnowledgeCrossDependency[]
}

type ProjectKnowledgeSnapshot = {
  id: string
  promptVersion: string
  provider?: string | null
  model?: string | null
  sourceWorkItemCount: number
  rawOutput?: string | null
  knowledgeBase: ProjectKnowledgeBase
  status: string
  extractedAt: string
  createdAt?: string
  updatedAt?: string
  health: {
    freshness: string
    provenance: string
    compilerCompatibility: string
    staleSince?: string | null
    timeToRefreshMs?: number | null
    rawContextRequired: boolean
    trustedCompiledRetrieval: boolean
    warnings: string[]
  }
}

type KnowledgeGeneratedDraft = {
  draftId: string
  draftStatus: string
  blockers: ProjectKnowledgeDraftBlocker[]
  reviewSummary: ProjectKnowledgeReviewSummary
  regenerateRequired?: boolean
  promptVersion: string
  provider: string
  model: string
  requestedMode: KnowledgeCompileMode
  mode: KnowledgeCompileMode
  fallbackReason?: string
  sourceWorkItemCount: number
  promptedSourceWorkItemCount: number
  changedSourceWorkItemCount: number
  changedSourceWorkItemIds: string[]
  retiredSourceWorkItemCount: number
  retiredSourceWorkItemIds: string[]
  rawOutput: string
  knowledgeBase: ProjectKnowledgeBase
  generatedAt: string
  alreadyCurrent?: boolean
  tokenUsage?: TokenUsage
}

type KnowledgePersistedDraft = {
  id: string
  status: string
  persistedStatus?: string
  statusReason?: string | null
  blockers: ProjectKnowledgeDraftBlocker[]
  reviewSummary: ProjectKnowledgeReviewSummary
  regenerateRequired?: boolean
  proposedKnowledge?: ProjectKnowledgeBase | null
  knowledgeBase?: ProjectKnowledgeBase | null
}

type KnowledgeStatusResult = {
  snapshot: ProjectKnowledgeSnapshot | null
}

type KnowledgeLintIssue = {
  id: string
  issueType: string
  severity: "info" | "warning" | "error"
  title: string
  message: string
  category?: string | null
  entryKey?: string | null
  sourceWorkItemIds: string[]
  status: string
  origin: "deterministic" | "human"
  createdAt: string
  updatedAt: string
}

type KnowledgeLintResult = {
  runId?: string
  issues: KnowledgeLintIssue[]
  summary: {
    total: number
    errors: number
    warnings: number
    info: number
  }
}

type KnowledgeLogItem = {
  id: string
  eventType: string
  severity: "info" | "warning" | "error"
  title: string
  message: string
  sourceIds: string[]
  createdAt: string
}

type KnowledgeLogResult = {
  items: KnowledgeLogItem[]
}

type KnowledgeExportResult = {
  exportRoot: string
  fileCount: number
}

type KnowledgeManualBatchPrompt = {
  batchIndex: number
  batchCount: number
  workItemCount: number
  prompt: string
  carriedForward?: boolean
  carriedRawOutput?: string
  carriedKnowledgeBase?: ProjectKnowledgeBase
}

type KnowledgeManualDraft = {
  draftId: string
  draftStatus: string
  promptVersion: string
  requestedMode: KnowledgeCompileMode
  mode: KnowledgeCompileMode
  fallbackReason?: string
  sourceWorkItemCount: number
  totalSourceWorkItemCount: number
  changedSourceWorkItemCount: number
  retiredSourceWorkItemCount: number
  batchCount: number
  batches: KnowledgeManualBatchPrompt[]
}

type KnowledgeManualValidationResult = {
  knowledgeBase: ProjectKnowledgeBase
  snapshot?: ProjectKnowledgeSnapshot
  draft?: KnowledgePersistedDraft
}

type BuildMode = "auto" | "manual"
type BuildStep = "index" | "prepare" | "preview"
type TopTab = "hub" | "build"
type WorkspaceRole = "owner" | "admin" | "member"
type HubView = "explorer" | "context" | "candidates" | "governance"
type KnowledgeCandidateStatus = "legacy_ungrounded" | "grounded" | "rejected" | "integration_requested"

type KnowledgeCandidate = {
  id: string
  title: string
  content: string
  status: KnowledgeCandidateStatus
  sourceWorkItemIds: string[]
  evidenceRefs: unknown[]
  citations: unknown[]
  rejectedReason?: string | null
  updatedAt: string
}

type KnowledgeGovernance = {
  rollout: {
    milestone3GaAt: string | null
    reconciliationPublicationCount: number
    measuredDraftCount: number
    evaluationReady: boolean
    minimumPercentageSample: boolean
  }
  gates: {
    richerSynthesisEligible: boolean
    semanticLintEligible: boolean
    candidateAcceptanceEligible: boolean
    hardTensionDraftRate: number
    confirmedLintMissRate: number
    integrationRequestCount: number
  }
  adrs: Array<{
    id: string
    type: string
    status: string
    metricSnapshot: Record<string, unknown>
    decision?: string | null
    createdAt: string
    decidedAt?: string | null
  }>
}

const KNOWLEDGE_CATEGORIES = [
  { key: "modules", label: "Modules", badge: "Module" },
  { key: "businessRules", label: "Business Rules", badge: "Business Rule" },
  { key: "stateTransitions", label: "State Transitions", badge: "State Transition" },
  { key: "glossary", label: "Glossary", badge: "Glossary" },
  { key: "crossDependencies", label: "Dependencies", badge: "Dependency" },
] as const

type KnowledgeCategoryKey = (typeof KNOWLEDGE_CATEGORIES)[number]["key"]
type KnowledgeExplorerCategory = KnowledgeCategoryKey | "all"
const NO_HIGHLIGHTED_KNOWLEDGE_ENTRIES: string[] = []

type AnyKnowledgeItem = KnowledgeSource & {
  id?: string
  name?: string
  description?: string
  rule?: string
  sourceField?: string
  moduleName?: string
  workflowName?: string
  fromState?: string
  toState?: string
  triggerOrCondition?: string
  actor?: string
  term?: string
  type?: string
  definition?: string
  sourceModule?: string
  targetModule?: string
  dependencyType?: string
}

type KnowledgeExplorerEntry = {
  key: string
  highlightIdentity: string
  category: KnowledgeCategoryKey
  categoryLabel: string
  badge: string
  title: string
  description: string
  evidence: string
  sourceWorkItemIds: string[]
  meta: string[]
  searchText: string
}

export function KnowledgeHubClient({ workspaceRole }: { workspaceRole: WorkspaceRole | null }) {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null)
  const [activeTab, setActiveTab] = useState<TopTab>("hub")
  const [hubView, setHubView] = useState<HubView>("explorer")
  const [buildMode, setBuildMode] = useState<BuildMode>("auto")
  const [buildStep, setBuildStep] = useState<BuildStep>("index")
  const [compileMode, setCompileMode] = useState<KnowledgeCompileMode>("incremental")
  const [workItemTypes, setWorkItemTypes] = useState<string[]>(DEFAULT_CONTEXT_WORK_ITEM_TYPES)
  const [states, setStates] = useState<string[]>(DEFAULT_CONTEXT_STATES)
  const [buildLoading, setBuildLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [result, setResult] = useState<IndexResult | null>(null)
  const [recentItems, setRecentItems] = useState<RecentContextItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [contextSearch, setContextSearch] = useState("")
  const [knowledgeStatusLoading, setKnowledgeStatusLoading] = useState(false)
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null)
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState<ProjectKnowledgeSnapshot | null>(null)
  const [knowledgeLint, setKnowledgeLint] = useState<KnowledgeLintResult | null>(null)
  const [knowledgeLog, setKnowledgeLog] = useState<KnowledgeLogItem[]>([])
  const [knowledgeLogVisible, setKnowledgeLogVisible] = useState(false)
  const [knowledgeExport, setKnowledgeExport] = useState<KnowledgeExportResult | null>(null)
  const [knowledgeHealthLoading, setKnowledgeHealthLoading] = useState(false)
  const [knowledgeLogLoading, setKnowledgeLogLoading] = useState(false)
  const [knowledgeExportLoading, setKnowledgeExportLoading] = useState(false)
  const [knowledgeCandidates, setKnowledgeCandidates] = useState<KnowledgeCandidate[]>([])
  const [candidateStatus, setCandidateStatus] = useState<KnowledgeCandidateStatus | "all">("all")
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [knowledgeGovernance, setKnowledgeGovernance] = useState<KnowledgeGovernance | null>(null)
  const [governanceLoading, setGovernanceLoading] = useState(false)
  const [generatedDraft, setGeneratedDraft] = useState<KnowledgeGeneratedDraft | null>(null)
  const [generatedSaveLoading, setGeneratedSaveLoading] = useState(false)
  const [manualKnowledgeDraft, setManualKnowledgeDraft] = useState<KnowledgeManualDraft | null>(null)
  const [manualKnowledgeReviewDraft, setManualKnowledgeReviewDraft] = useState<KnowledgePersistedDraft | null>(null)
  const [manualKnowledgeCurrentBatch, setManualKnowledgeCurrentBatch] = useState(1)
  const [manualKnowledgeBatchResponses, setManualKnowledgeBatchResponses] = useState<Record<number, string>>({})
  const [manualKnowledgeValidatedBatches, setManualKnowledgeValidatedBatches] = useState<Record<number, ProjectKnowledgeBase>>({})
  const [manualKnowledgeValidationLoading, setManualKnowledgeValidationLoading] = useState(false)
  const [manualKnowledgeSaveLoading, setManualKnowledgeSaveLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalPages, setTotalPages] = useState(1)
  const gen = useAiGeneration()
  const cancelKnowledgeGeneration = gen.cancel
  const [sortBy, setSortBy] = useState<ContextSortBy>("lastIndexedAt")
  const [sortDirection, setSortDirection] = useState<ContextSortDirection>("desc")
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false)
  useUnsavedChangesGuard({
    dirty: hasUnfinishedWork,
    busy:
      buildLoading ||
      gen.isRunning ||
      generatedSaveLoading ||
      manualKnowledgeValidationLoading ||
      manualKnowledgeSaveLoading,
  })
  const autoIndexStepRef = useRef<HTMLDivElement | null>(null)
  const autoPrepareStepRef = useRef<HTMLDivElement | null>(null)
  const autoPreviewStepRef = useRef<HTMLDivElement | null>(null)
  const manualIndexStepRef = useRef<HTMLDivElement | null>(null)
  const manualPrepareStepRef = useRef<HTMLDivElement | null>(null)
  const manualPreviewStepRef = useRef<HTMLDivElement | null>(null)
  const manualBatchRef = useRef<HTMLDivElement | null>(null)
  const initializedFilterProjectRef = useRef<string | null>(null)
  const loadingGame = useLlmLoadingGameSession<KnowledgeGeneratedDraft>((draft) => {
    setGeneratedDraft(draft)
    if (draft.alreadyCurrent) setHasUnfinishedWork(false)
    setBuildStep(draft.alreadyCurrent ? "prepare" : "preview")
    scrollBuildSection(draft.alreadyCurrent ? autoPrepareStepRef : autoPreviewStepRef)
  })
  const endLoadingGameSession = loadingGame.endSession
  const filterProjectKey = projectScopeKey(scope)
  const {
    metadata: workItemMetadata,
    loading: workItemMetadataLoading,
    error: workItemMetadataError,
    retry: retryWorkItemMetadata,
  } = useProjectWorkItemMetadata(scope)
  const canBuildKnowledge = workspaceRole === "owner" || workspaceRole === "admin"

  const refreshKnowledgeLog = useCallback(async (activeScope: ActiveProjectScope | null = scope) => {
    if (!activeScope) return
    setKnowledgeLogLoading(true)
    try {
      const data = await postJson<KnowledgeLogResult>("/api/context/knowledge/log", { scope: activeScope, limit: 20 })
      setKnowledgeLog(data.items)
    } catch {
      setKnowledgeLog([])
    } finally {
      setKnowledgeLogLoading(false)
    }
  }, [scope])

  const refreshKnowledgeStatus = useCallback(async (activeScope: ActiveProjectScope | null = scope) => {
    if (!activeScope) return
    setKnowledgeStatusLoading(true)
    try {
      const data = await postJson<KnowledgeStatusResult>("/api/context/knowledge/status", { scope: activeScope })
      setKnowledgeSnapshot(data.snapshot)
    } catch {
      setKnowledgeSnapshot(null)
    } finally {
      setKnowledgeStatusLoading(false)
    }
  }, [scope])

  const refreshKnowledgeCandidates = useCallback(async (
    activeScope: ActiveProjectScope | null = scope,
    status: KnowledgeCandidateStatus | "all" = candidateStatus,
  ) => {
    if (!activeScope) return
    setCandidateLoading(true)
    try {
      const data = await postJson<{ candidates: KnowledgeCandidate[] }>("/api/context/knowledge/candidates", {
        scope: activeScope,
        ...(status === "all" ? {} : { status }),
        limit: 100,
      })
      setKnowledgeCandidates(data.candidates)
    } catch {
      setKnowledgeCandidates([])
    } finally {
      setCandidateLoading(false)
    }
  }, [candidateStatus, scope])

  const refreshKnowledgeGovernance = useCallback(async (activeScope: ActiveProjectScope | null = scope) => {
    if (!activeScope) return
    setGovernanceLoading(true)
    try {
      setKnowledgeGovernance(await postJson<KnowledgeGovernance>("/api/context/knowledge/governance", { scope: activeScope }))
    } catch {
      setKnowledgeGovernance(null)
    } finally {
      setGovernanceLoading(false)
    }
  }, [scope])

  const loadStatus = useCallback(async (
    activeScope: ActiveProjectScope | null,
    options?: {
      page?: number
      sortBy?: ContextSortBy
      sortDirection?: ContextSortDirection
      query?: string
    },
  ) => {
    if (!activeScope) return
    const nextPage = options?.page ?? 1
    const nextSortBy = options?.sortBy ?? "lastIndexedAt"
    const nextSortDirection = options?.sortDirection ?? "desc"
    const nextQuery = options?.query ?? ""

    setStatusLoading(true)
    try {
      const data = await postJson<ContextStatusResult>("/api/context/status", {
        scope: activeScope,
        page: nextPage,
        pageSize,
        sortBy: nextSortBy,
        sortDirection: nextSortDirection,
        query: nextQuery,
      })
      setRecentItems(data.items)
      setTotalCount(data.totalCount)
      setTotalPages(data.totalPages)
      setPage(data.page)
      setSortBy(data.sortBy)
      setSortDirection(data.sortDirection)
    } catch {
      setRecentItems([])
      setTotalCount(0)
      setTotalPages(1)
    } finally {
      setStatusLoading(false)
    }
  }, [pageSize])

  useEffect(() => {
    setScope(readActiveProject())
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>
      cancelKnowledgeGeneration()
      endLoadingGameSession()
      setScope(custom.detail ?? readActiveProject())
      setHasUnfinishedWork(false)
    }
    window.addEventListener("itestflow:active-project-changed", onChange)
    return () => window.removeEventListener("itestflow:active-project-changed", onChange)
  }, [cancelKnowledgeGeneration, endLoadingGameSession])

  useEffect(() => {
    if (!canBuildKnowledge && activeTab === "build") setActiveTab("hub")
  }, [activeTab, canBuildKnowledge])

  useEffect(() => {
    if (!filterProjectKey) {
      initializedFilterProjectRef.current = null
      return
    }
    if (!workItemMetadata || initializedFilterProjectRef.current === filterProjectKey) return

    initializedFilterProjectRef.current = filterProjectKey
    setWorkItemTypes(selectAvailableDefaults(DEFAULT_CONTEXT_WORK_ITEM_TYPES, workItemMetadata.workItemTypes))
    setStates(selectAvailableDefaults(DEFAULT_CONTEXT_STATES, workItemMetadata.states))
  }, [filterProjectKey, workItemMetadata])

  useEffect(() => {
    if (!scope) return
    let cancelled = false

    setBuildStep("index")
    setBuildError(null)
    setResult(null)
    setGeneratedDraft(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeReviewDraft(null)
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    setKnowledgeError(null)
    setKnowledgeLint(null)
    setKnowledgeLog([])
    setKnowledgeLogVisible(false)
    setKnowledgeExport(null)
    setKnowledgeCandidates([])
    setCandidateStatus("all")
    setKnowledgeGovernance(null)
    setPage(1)
    setSortBy("lastIndexedAt")
    setSortDirection("desc")
    setContextSearch("")
    setStatusLoading(true)
    setKnowledgeStatusLoading(true)

    void postJson<ContextStatusResult>("/api/context/status", {
      scope,
      page: 1,
      pageSize,
      sortBy: "lastIndexedAt",
      sortDirection: "desc",
      query: "",
    })
      .then((data) => {
        if (cancelled) return
        setRecentItems(data.items)
        setTotalCount(data.totalCount)
        setTotalPages(data.totalPages)
        setPage(data.page)
        setSortBy(data.sortBy)
        setSortDirection(data.sortDirection)
      })
      .catch(() => {
        if (cancelled) return
        setRecentItems([])
        setTotalCount(0)
        setTotalPages(1)
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false)
      })

    void postJson<KnowledgeStatusResult>("/api/context/knowledge/status", { scope })
      .then((data) => {
        if (!cancelled) setKnowledgeSnapshot(data.snapshot)
      })
      .catch(() => {
        if (!cancelled) setKnowledgeSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setKnowledgeStatusLoading(false)
      })

    void refreshKnowledgeLog(scope)

    return () => {
      cancelled = true
    }
  }, [pageSize, refreshKnowledgeLog, scope])

  useEffect(() => {
    if (scope) void refreshKnowledgeCandidates(scope, candidateStatus)
  }, [candidateStatus, refreshKnowledgeCandidates, scope])

  useEffect(() => {
    if (scope) void refreshKnowledgeGovernance(scope)
  }, [refreshKnowledgeGovernance, scope])

  useEffect(() => {
    if (!scope) return
    const timeoutId = window.setTimeout(() => {
      setPage(1)
      void loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch })
    }, 300)

    return () => window.clearTimeout(timeoutId)
  }, [contextSearch, loadStatus, scope, sortBy, sortDirection])

  function scrollBuildSection(ref: RefObject<HTMLDivElement | null>) {
    window.requestAnimationFrame(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" })
    })
  }

  function activeIndexStepRef() {
    return buildMode === "manual" ? manualIndexStepRef : autoIndexStepRef
  }

  function activePrepareStepRef() {
    return buildMode === "manual" ? manualPrepareStepRef : autoPrepareStepRef
  }

  function clearPreparedKnowledge() {
    setGeneratedDraft(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeReviewDraft(null)
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
  }

  function resetBuildState() {
    gen.cancel()
    loadingGame.endSession()
    setBuildStep("index")
    setBuildError(null)
    setResult(null)
    clearPreparedKnowledge()
  }

  function invalidateBuildIndex() {
    setBuildStep("index")
    setBuildError(null)
    setResult(null)
    clearPreparedKnowledge()
  }

  function changeWorkItemTypes(values: string[]) {
    setHasUnfinishedWork(true)
    setWorkItemTypes(values)
    invalidateBuildIndex()
  }

  function changeStates(values: string[]) {
    setHasUnfinishedWork(true)
    setStates(values)
    invalidateBuildIndex()
  }

  function changeCompileMode(nextMode: KnowledgeCompileMode) {
    gen.cancel()
    loadingGame.endSession()
    setHasUnfinishedWork(true)
    setCompileMode(nextMode)
    setBuildError(null)
    clearPreparedKnowledge()
    if (buildStep === "preview") setBuildStep(result ? "prepare" : "index")
  }

  async function indexContextForBuild() {
    if (!scope) throw new Error("Select an Azure DevOps project before loading the project index.")
    const data = await postJson<IndexResult>("/api/context/index", {
      scope,
      workItemTypes,
      states,
      mode: "incremental",
    })
    setResult(data)
    setPage(1)
    await loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch })
    return data
  }

  async function loadProjectIndexForBuild() {
    if (!scope) return
    setHasUnfinishedWork(true)
    setBuildLoading(true)
    setBuildError(null)
    clearPreparedKnowledge()
    try {
      await indexContextForBuild()
      setBuildStep("prepare")
      scrollBuildSection(activePrepareStepRef())
    } catch (indexError) {
      setBuildStep("index")
      setBuildError(indexError instanceof Error ? indexError.message : "Project index loading failed.")
    } finally {
      setBuildLoading(false)
    }
  }

  async function prepareAutoKnowledge() {
    if (!scope) return
    if (!result) {
      setBuildStep("index")
      setBuildError("Load the project index before preparing a knowledge preview.")
      scrollBuildSection(activeIndexStepRef())
      return
    }
    if (gen.isRunning) return

    loadingGame.startSession()
    setHasUnfinishedWork(true)
    setBuildError(null)
    setGeneratedDraft(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeReviewDraft(null)
    setManualKnowledgeValidatedBatches({})
    const draft = await gen.start((signal) =>
      postJson<KnowledgeGeneratedDraft>("/api/context/knowledge/preview", { scope, mode: compileMode }, signal),
    )
    if (!draft) {
      loadingGame.endSession()
      return // cancelled or failed: the progress panel owns the message
    }
    loadingGame.completeSession(draft)
  }

  async function regenerateAutoKnowledge() {
    if (!scope || gen.isRunning || buildLoading) return

    setHasUnfinishedWork(true)
    setBuildLoading(true)
    setBuildError(null)
    try {
      await indexContextForBuild()
      loadingGame.startSession()
      const replacement = await gen.start((signal) =>
        postJson<KnowledgeGeneratedDraft>("/api/context/knowledge/preview", { scope, mode: compileMode }, signal),
      )
      if (!replacement) {
        loadingGame.endSession()
        return
      }
      loadingGame.completeSession(replacement)
    } catch (regenerationError) {
      loadingGame.endSession()
      const detail = regenerationError instanceof Error
        ? regenerationError.message
        : "Source refresh or draft regeneration failed."
      setBuildError(`The knowledge draft could not be regenerated. Your current draft was kept; retry when the source is available. ${detail}`)
    } finally {
      setBuildLoading(false)
    }
  }

  function applyManualKnowledgePreparation(data: KnowledgeManualDraft) {
    setManualKnowledgeDraft(data)
    setManualKnowledgeReviewDraft(null)
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses(Object.fromEntries(
      data.batches.filter((batch) => batch.carriedForward && batch.carriedRawOutput !== undefined)
        .map((batch) => [batch.batchIndex, batch.carriedRawOutput!]),
    ))
    setManualKnowledgeValidatedBatches(Object.fromEntries(
      data.batches.filter((batch) => batch.carriedForward && batch.carriedKnowledgeBase)
        .map((batch) => [batch.batchIndex, batch.carriedKnowledgeBase!]),
    ))
    const nextStep = data.batchCount === 0 && data.retiredSourceWorkItemCount > 0 ? "preview" : "prepare"
    setBuildStep(nextStep)
    scrollBuildSection(nextStep === "preview" ? manualPreviewStepRef : manualPrepareStepRef)
  }

  async function prepareExternalKnowledge() {
    if (!scope) return
    if (!result) {
      setBuildStep("index")
      setBuildError("Load the project index before preparing an external LLM prompt.")
      scrollBuildSection(activeIndexStepRef())
      return
    }

    setHasUnfinishedWork(true)
    setBuildLoading(true)
    setBuildError(null)
    setGeneratedDraft(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeReviewDraft(null)
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    scrollBuildSection(manualPrepareStepRef)
    try {
      const data = await postJson<KnowledgeManualDraft>("/api/context/knowledge/manual/draft", { scope, mode: compileMode })
      applyManualKnowledgePreparation(data)
    } catch (prepareError) {
      setBuildError(prepareError instanceof Error ? prepareError.message : "External LLM knowledge prompt preparation failed.")
    } finally {
      setBuildLoading(false)
    }
  }

  async function regenerateExternalKnowledge() {
    if (!scope || buildLoading) return

    setHasUnfinishedWork(true)
    setBuildLoading(true)
    setBuildError(null)
    try {
      await indexContextForBuild()
      const replacement = await postJson<KnowledgeManualDraft>("/api/context/knowledge/manual/draft", {
        scope,
        mode: compileMode,
      })
      applyManualKnowledgePreparation(replacement)
    } catch (regenerationError) {
      const detail = regenerationError instanceof Error
        ? regenerationError.message
        : "Source refresh or prompt regeneration failed."
      setBuildError(`The external LLM draft could not be regenerated. Your current draft was kept; retry when the source is available. ${detail}`)
    } finally {
      setBuildLoading(false)
    }
  }

  async function validateManualKnowledgeBatch() {
    if (!scope || !manualKnowledgeDraft) return
    const batch = manualKnowledgeDraft.batches.find((item) => item.batchIndex === manualKnowledgeCurrentBatch)
    if (!batch) return
    const rawOutput = manualKnowledgeBatchResponses[batch.batchIndex]?.trim()
    if (!rawOutput) return

    setManualKnowledgeValidationLoading(true)
    setBuildError(null)
    try {
      const data = await postJson<KnowledgeManualValidationResult>("/api/context/knowledge/manual/validate", {
        scope,
        rawOutput,
        draftId: manualKnowledgeDraft.draftId,
        batchIndex: batch.batchIndex,
      })

      const nextValidated = {
        ...manualKnowledgeValidatedBatches,
        [batch.batchIndex]: data.knowledgeBase,
      }
      setManualKnowledgeValidatedBatches(nextValidated)
      const nextBatch = manualKnowledgeDraft.batches.find((item) => !nextValidated[item.batchIndex])
      if (nextBatch) {
        setManualKnowledgeCurrentBatch(nextBatch.batchIndex)
        scrollBuildSection(manualBatchRef)
      } else {
        setBuildStep("preview")
        scrollBuildSection(manualPreviewStepRef)
      }
    } catch (validationError) {
      setBuildError(validationError instanceof Error ? validationError.message : "External LLM knowledge response validation failed.")
    } finally {
      setManualKnowledgeValidationLoading(false)
    }
  }

  async function saveGeneratedKnowledge() {
    if (!scope || !generatedDraft) return
    setGeneratedSaveLoading(true)
    setBuildError(null)
    try {
      await postJson("/api/context/knowledge/save", {
        scope,
        draftId: generatedDraft.draftId,
      })
      setHasUnfinishedWork(false)
      resetBuildState()
      setActiveTab("hub")
      await Promise.all([
        loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch }),
        refreshKnowledgeStatus(scope),
        refreshKnowledgeLog(scope),
      ])
    } catch (saveError) {
      setBuildError(saveError instanceof Error ? saveError.message : "Project knowledge save failed.")
      try {
        const current = await postJson<{ draft: KnowledgePersistedDraft }>(
          `/api/context/knowledge/drafts/${generatedDraft.draftId}`,
          { scope },
        )
        applyPersistedDraftToGenerated(current.draft)
      } catch {
        // Keep the original publication error; draft refresh is best effort.
      }
    } finally {
      setGeneratedSaveLoading(false)
    }
  }

  function applyPersistedDraftToGenerated(draft: KnowledgePersistedDraft) {
    setGeneratedDraft((current) => current ? ({
      ...current,
      draftId: draft.id,
      draftStatus: draft.persistedStatus ?? draft.status,
      blockers: draft.blockers ?? [],
      reviewSummary: draft.reviewSummary,
      regenerateRequired: draft.regenerateRequired ?? false,
      knowledgeBase: draft.proposedKnowledge ?? draft.knowledgeBase ?? current.knowledgeBase,
    }) : current)
  }

  async function loadKnowledgeReviewContext(draftId: string) {
    if (!scope) throw new Error("Select an active project before reviewing knowledge evidence.")
    const data = await postJson<{ reviewContext: ProjectKnowledgeReviewContext }>(
      `/api/context/knowledge/drafts/${draftId}/review-context`,
      { scope },
    )
    return data.reviewContext
  }

  async function resolveGeneratedKnowledgeDraft(proposedKnowledge: ProjectKnowledgeBase) {
    if (!scope || !generatedDraft) return
    setGeneratedSaveLoading(true)
    setBuildError(null)
    try {
      const data = await postJson<{ draft: KnowledgePersistedDraft }>(
        `/api/context/knowledge/drafts/${generatedDraft.draftId}/resolve`,
        { scope, proposedKnowledge },
      )
      applyPersistedDraftToGenerated(data.draft)
      return data.draft
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Project knowledge resolution failed.")
      throw error
    } finally {
      setGeneratedSaveLoading(false)
    }
  }

  async function rebaseGeneratedKnowledgeDraft() {
    if (!scope || !generatedDraft) return
    setGeneratedSaveLoading(true)
    setBuildError(null)
    try {
      const data = await postJson<{ draft: KnowledgePersistedDraft }>(
        `/api/context/knowledge/drafts/${generatedDraft.draftId}/rebase`,
        { scope },
      )
      applyPersistedDraftToGenerated(data.draft)
      if ((data.draft.persistedStatus ?? data.draft.status) === "published") {
        setHasUnfinishedWork(false)
        setActiveTab("hub")
        await Promise.all([refreshKnowledgeStatus(scope), refreshKnowledgeLog(scope)])
      }
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Project knowledge rebase failed.")
    } finally {
      setGeneratedSaveLoading(false)
    }
  }

  async function saveManualKnowledgeBatches() {
    if (!scope || !manualKnowledgeDraft) return
    const partialKnowledgeBases = manualKnowledgeDraft.batches
      .map((batch) => manualKnowledgeValidatedBatches[batch.batchIndex])
      .filter(Boolean)
    if (manualKnowledgeDraft.batchCount > 0 && partialKnowledgeBases.length !== manualKnowledgeDraft.batchCount) return
    if (manualKnowledgeDraft.batchCount === 0 && manualKnowledgeDraft.mode !== "incremental") return

    setManualKnowledgeSaveLoading(true)
    setBuildError(null)
    try {
      if (!manualKnowledgeReviewDraft) {
        const data = await postJson<KnowledgeManualValidationResult>("/api/context/knowledge/manual/finalize", {
          scope,
          mode: manualKnowledgeDraft.mode,
          draftId: manualKnowledgeDraft.draftId,
          partialKnowledgeBases,
        })
        if (!data.draft) throw new Error("Manual finalization did not return a reviewable draft.")
        setManualKnowledgeReviewDraft(data.draft)
        setHasUnfinishedWork(true)
        return
      }
      const status = manualKnowledgeReviewDraft.persistedStatus ?? manualKnowledgeReviewDraft.status
      if (status !== "ready_for_review" || manualKnowledgeReviewDraft.blockers.length || manualKnowledgeReviewDraft.regenerateRequired) return
      await postJson("/api/context/knowledge/save", { scope, draftId: manualKnowledgeReviewDraft.id })
      setHasUnfinishedWork(false)
      resetBuildState()
      setActiveTab("hub")
      await Promise.all([
        loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch }),
        refreshKnowledgeStatus(scope),
        refreshKnowledgeLog(scope),
      ])
    } catch (saveError) {
      setBuildError(saveError instanceof Error ? saveError.message : "External LLM knowledge base save failed.")
    } finally {
      setManualKnowledgeSaveLoading(false)
    }
  }

  async function resolveManualKnowledgeDraft(proposedKnowledge: ProjectKnowledgeBase) {
    if (!scope || !manualKnowledgeReviewDraft) return
    setManualKnowledgeSaveLoading(true)
    setBuildError(null)
    try {
      const data = await postJson<{ draft: KnowledgePersistedDraft }>(
        `/api/context/knowledge/drafts/${manualKnowledgeReviewDraft.id}/resolve`,
        { scope, proposedKnowledge },
      )
      setManualKnowledgeReviewDraft(data.draft)
      return data.draft
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Manual knowledge resolution failed.")
      throw error
    } finally {
      setManualKnowledgeSaveLoading(false)
    }
  }

  async function rebaseManualKnowledgeDraft() {
    if (!scope || !manualKnowledgeReviewDraft) return
    setManualKnowledgeSaveLoading(true)
    setBuildError(null)
    try {
      const data = await postJson<{ draft: KnowledgePersistedDraft & { manualPreparation?: KnowledgeManualDraft } }>(
        `/api/context/knowledge/drafts/${manualKnowledgeReviewDraft.id}/rebase`,
        { scope },
      )
      if (data.draft.manualPreparation) {
        const preparation = data.draft.manualPreparation
        setManualKnowledgeDraft(preparation)
        setManualKnowledgeReviewDraft(null)
        setManualKnowledgeBatchResponses(Object.fromEntries(
          preparation.batches.filter((batch) => batch.carriedForward && batch.carriedRawOutput !== undefined)
            .map((batch) => [batch.batchIndex, batch.carriedRawOutput!]),
        ))
        setManualKnowledgeValidatedBatches(Object.fromEntries(
          preparation.batches.filter((batch) => batch.carriedForward && batch.carriedKnowledgeBase)
            .map((batch) => [batch.batchIndex, batch.carriedKnowledgeBase!]),
        ))
        setBuildStep(preparation.batches.every((batch) => batch.carriedForward) ? "preview" : "prepare")
      } else {
        setManualKnowledgeReviewDraft(data.draft)
      }
    } catch (error) {
      setBuildError(error instanceof Error ? error.message : "Manual knowledge rebase failed.")
    } finally {
      setManualKnowledgeSaveLoading(false)
    }
  }

  async function runKnowledgeHealthCheck() {
    if (!scope) return
    setKnowledgeHealthLoading(true)
    setKnowledgeError(null)
    try {
      const data = await postJson<KnowledgeLintResult>("/api/context/knowledge/lint", { scope, run: true })
      setKnowledgeLint(data)
      await refreshKnowledgeLog(scope)
    } catch (healthError) {
      setKnowledgeError(healthError instanceof Error ? healthError.message : "Project knowledge health check failed.")
    } finally {
      setKnowledgeHealthLoading(false)
    }
  }

  async function exportKnowledgeWiki() {
    if (!scope) return
    setKnowledgeExportLoading(true)
    setKnowledgeError(null)
    try {
      const data = await postJson<KnowledgeExportResult>("/api/context/knowledge/export", { scope })
      setKnowledgeExport(data)
      await refreshKnowledgeLog(scope)
    } catch (exportError) {
      setKnowledgeError(exportError instanceof Error ? exportError.message : "Project knowledge wiki export failed.")
    } finally {
      setKnowledgeExportLoading(false)
    }
  }

  async function toggleKnowledgeLog() {
    if (knowledgeLogVisible) {
      setKnowledgeLogVisible(false)
      return
    }

    setKnowledgeLogVisible(true)
    await refreshKnowledgeLog(scope)
  }

  async function reportKnowledgeLintMiss(input: {
    missType: "duplicate" | "conflict"
    title: string
    message: string
  }) {
    if (!scope) return
    setKnowledgeHealthLoading(true)
    setKnowledgeError(null)
    try {
      await postJson("/api/context/knowledge/lint/report", { scope, ...input })
      setKnowledgeLint(await postJson<KnowledgeLintResult>("/api/context/knowledge/lint", { scope, run: false }))
      await refreshKnowledgeLog(scope)
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The lint miss could not be reported.")
    } finally {
      setKnowledgeHealthLoading(false)
    }
  }

  async function transitionKnowledgeLintIssue(
    issueId: string,
    action: "confirm" | "reject" | "ignore" | "reopen",
  ) {
    if (!scope || !canBuildKnowledge) return
    setKnowledgeHealthLoading(true)
    setKnowledgeError(null)
    try {
      await patchJson(`/api/context/knowledge/lint/${issueId}`, { scope, action })
      setKnowledgeLint(await postJson<KnowledgeLintResult>("/api/context/knowledge/lint", { scope, run: false }))
      await refreshKnowledgeLog(scope)
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The lint report could not be reviewed.")
    } finally {
      setKnowledgeHealthLoading(false)
    }
  }

  async function updateKnowledgeCandidate(candidateId: string, action: "reject" | "request_integration") {
    if (!scope || !canBuildKnowledge) return
    setCandidateLoading(true)
    setKnowledgeError(null)
    try {
      await patchJson(`/api/context/knowledge/candidates/${candidateId}`, {
        scope,
        action,
        ...(action === "reject" ? { reason: "Rejected during Knowledge Hub review." } : {}),
      })
      await refreshKnowledgeCandidates(scope, candidateStatus)
      await refreshKnowledgeGovernance(scope)
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The candidate could not be updated.")
    } finally {
      setCandidateLoading(false)
    }
  }

  async function startMilestone3Ga() {
    if (!scope || !canBuildKnowledge) return
    setGovernanceLoading(true)
    setKnowledgeError(null)
    try {
      setKnowledgeGovernance(await patchJson<KnowledgeGovernance>("/api/context/knowledge/governance", {
        scope,
        action: "start_milestone3_ga",
      }))
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The GA measurement clock could not be started.")
    } finally {
      setGovernanceLoading(false)
    }
  }

  async function decideKnowledgeAdr(adrId: string, decision: string) {
    if (!scope || !canBuildKnowledge || !decision.trim()) return
    setGovernanceLoading(true)
    setKnowledgeError(null)
    try {
      setKnowledgeGovernance(await patchJson<KnowledgeGovernance>(`/api/context/knowledge/governance/${adrId}`, {
        scope,
        decision: decision.trim(),
      }))
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The ADR decision could not be saved.")
    } finally {
      setGovernanceLoading(false)
    }
  }

  function changeSort(nextSortBy: ContextSortBy) {
    const nextDirection = sortBy === nextSortBy && sortDirection === "asc" ? "desc" : "asc"
    setSortBy(nextSortBy)
    setSortDirection(nextDirection)
    setPage(1)
    if (scope) void loadStatus(scope, { page: 1, sortBy: nextSortBy, sortDirection: nextDirection, query: contextSearch })
  }

  function changePage(nextPage: number) {
    const safePage = Math.min(Math.max(1, nextPage), totalPages)
    setPage(safePage)
    if (scope) void loadStatus(scope, { page: safePage, sortBy, sortDirection, query: contextSearch })
  }

  function changeBuildMode(nextMode: BuildMode) {
    setHasUnfinishedWork(true)
    setBuildMode(nextMode)
    resetBuildState()
  }

  const currentManualKnowledgeBatch = manualKnowledgeDraft?.batches.find((batch) => batch.batchIndex === manualKnowledgeCurrentBatch)
  const manualKnowledgeValidatedCount = manualKnowledgeDraft
    ? manualKnowledgeDraft.batches.filter((batch) => manualKnowledgeValidatedBatches[batch.batchIndex]).length
    : 0
  const manualKnowledgeAllBatchesValidated = manualKnowledgeDraft
    ? manualKnowledgeValidatedCount === manualKnowledgeDraft.batchCount
    : false
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = totalCount === 0 ? 0 : Math.min(totalCount, rangeStart + recentItems.length - 1)
  const totalKnowledgeItems = knowledgeSnapshot ? countKnowledgeItems(knowledgeSnapshot.knowledgeBase) : 0
  const canLoadIndex = Boolean(scope)
    && Boolean(workItemMetadata)
    && !workItemMetadataLoading
    && !workItemMetadataError
    && workItemTypes.length > 0
    && states.length > 0
    && !buildLoading
  const canPrepareKnowledge = Boolean(scope) && Boolean(result) && !buildLoading
  const emptyKnowledgeMessage = canBuildKnowledge
    ? "No knowledge base has been saved yet. Use Build Knowledge to compile source-backed project knowledge."
    : "No knowledge base has been saved yet."
  const emptyContextMessage = canBuildKnowledge
    ? "No project context has been indexed yet. Use Build Knowledge to prepare context from Azure DevOps work items."
    : "No project context has been indexed yet."

  return (
    <div className="content-stack">
      {!scope ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/15 p-3 text-sm text-warning-foreground dark:text-warning">
          <AlertTriangle className="size-4" />
          {canBuildKnowledge
            ? "Select an Azure DevOps project before building project knowledge."
            : "Select an Azure DevOps project before viewing project knowledge."}
        </div>
      ) : null}

      <Tabs
        id="knowledge-hub-sections"
        value={activeTab}
        onValueChange={(value) => {
          const nextTab = value as TopTab
          if (nextTab === "build" && !canBuildKnowledge) return
          setActiveTab(nextTab)
        }}
        className="flex-col gap-4"
      >
        <TabsList
          variant="primary"
          aria-label="Knowledge Hub section"
          className={`grid h-auto w-full sm:inline-grid sm:w-fit ${canBuildKnowledge ? "grid-cols-2 sm:min-w-[460px]" : "grid-cols-1 sm:min-w-[220px]"}`}
        >
          <TabsTrigger
            value="hub"
            className="h-11 px-3 py-2 duration-ui"
          >
            Knowledge Hub
          </TabsTrigger>
          {canBuildKnowledge ? (
            <TabsTrigger
              value="build"
              className="h-11 px-3 py-2 duration-ui"
            >
              Build Knowledge
            </TabsTrigger>
          ) : null}
        </TabsList>

        <TabsContent value="hub" className="content-stack">
          <HubSummary
            activeSourceCount={totalCount}
            totalKnowledgeItems={totalKnowledgeItems}
            snapshot={knowledgeSnapshot}
            loading={knowledgeStatusLoading}
          />

          {knowledgeSnapshot?.health.warnings.length ? (
            <div role="status" className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-warning-foreground sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div>
                  <div className="font-semibold">Published knowledge needs attention</div>
                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {knowledgeSnapshot.health.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                  {knowledgeSnapshot.health.staleSince ? (
                    <div className="mt-2 text-xs">Stale since {formatDate(knowledgeSnapshot.health.staleSince)}. Raw indexed evidence remains authoritative.</div>
                  ) : null}
                  {!canBuildKnowledge ? <div className="mt-2 text-xs">Ask a workspace owner or admin to refresh and review the knowledge draft.</div> : null}
                </div>
              </div>
              {canBuildKnowledge ? (
                <Button size="sm" variant="outline" onClick={() => setActiveTab("build")}>Refresh knowledge</Button>
              ) : null}
            </div>
          ) : null}

          <KnowledgeOpsPanel
            lint={knowledgeLint}
            logItems={knowledgeLog}
            logVisible={knowledgeLogVisible}
            exportResult={knowledgeExport}
            healthLoading={knowledgeHealthLoading}
            logLoading={knowledgeLogLoading}
            exportLoading={knowledgeExportLoading}
            canManage={canBuildKnowledge}
            onRunHealthCheck={runKnowledgeHealthCheck}
            onToggleLog={toggleKnowledgeLog}
            onExport={exportKnowledgeWiki}
            onReportMiss={reportKnowledgeLintMiss}
            onTransitionIssue={transitionKnowledgeLintIssue}
          />

          {knowledgeError ? (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>{knowledgeError}</span>
            </div>
          ) : null}

          <Card className="qa-card min-w-0">
            <Tabs
              id="knowledge-hub-views"
              value={hubView}
              onValueChange={(value) => setHubView(value as HubView)}
              className="flex-col gap-0"
            >
              <div className="border-b border-border">
                <TabsList
                  variant="line"
                  aria-label="Knowledge content view"
                  className="group-data-horizontal/tabs:h-auto grid w-full grid-cols-2 gap-1 px-3 py-0 sm:flex sm:justify-start sm:gap-5 sm:px-4"
                >
                  <HubViewTab value="explorer" label="Knowledge Explorer" shortLabel="Explorer" count={knowledgeStatusLoading ? "-" : totalKnowledgeItems} />
                  <HubViewTab value="context" label="Indexed Project Context" shortLabel="Indexed Context" count={totalCount} />
                  <HubViewTab value="candidates" label="Candidates" shortLabel="Candidates" count={knowledgeCandidates.length} />
                  <HubViewTab value="governance" label="Governance" shortLabel="Governance" count={knowledgeGovernance?.adrs.length ?? 0} />
                </TabsList>
              </div>

              <CardContent className="pt-4">
                <TabsContent value="explorer" className="mt-0">
                  {knowledgeStatusLoading ? (
                    <KnowledgeLoadingState label="Loading saved knowledge base" />
                  ) : knowledgeSnapshot ? (
                    <KnowledgeExplorer knowledgeBase={knowledgeSnapshot.knowledgeBase} />
                  ) : (
                    <KnowledgeEmptyState
                      title="No compiled knowledge yet"
                      message={emptyKnowledgeMessage}
                      actionLabel={canBuildKnowledge ? "Build Knowledge" : undefined}
                      onAction={canBuildKnowledge ? () => setActiveTab("build") : undefined}
                    />
                  )}
                </TabsContent>

                <TabsContent value="context" className="mt-0">
                  <IndexedContextView
                    items={recentItems}
                    totalCount={totalCount}
                    rangeStart={rangeStart}
                    rangeEnd={rangeEnd}
                    page={page}
                    totalPages={totalPages}
                    sortBy={sortBy}
                    sortDirection={sortDirection}
                    search={contextSearch}
                    loading={statusLoading}
                    emptyMessage={emptyContextMessage}
                    onSearchChange={setContextSearch}
                    onSortChange={changeSort}
                    onPageChange={changePage}
                  />
                </TabsContent>

                <TabsContent value="candidates" className="mt-0">
                  <KnowledgeCandidatesView
                    candidates={knowledgeCandidates}
                    status={candidateStatus}
                    loading={candidateLoading}
                    canManage={canBuildKnowledge}
                    onStatusChange={setCandidateStatus}
                    onAction={updateKnowledgeCandidate}
                  />
                </TabsContent>

                <TabsContent value="governance" className="mt-0">
                  <KnowledgeGovernanceView
                    governance={knowledgeGovernance}
                    loading={governanceLoading}
                    canManage={canBuildKnowledge}
                    onStart={startMilestone3Ga}
                    onDecide={decideKnowledgeAdr}
                  />
                </TabsContent>
              </CardContent>
            </Tabs>
          </Card>
        </TabsContent>

        {canBuildKnowledge ? (
        <TabsContent value="build" className="space-y-4">
          <Card className="qa-card">
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base" role="heading" aria-level={2}>Build Knowledge</CardTitle>
                  {knowledgeSnapshot ? <Badge variant="outline">Prompt {knowledgeSnapshot.promptVersion}</Badge> : null}
                </div>
                <GenerationModeToggle
                  mode={buildMode}
                  onChange={changeBuildMode}
                  ariaLabel="Knowledge build mode"
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={buildMode} className="flex-col gap-4">
                <BuildStepper step={buildStep} />

                {buildError ? (
                  <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>{buildError}</span>
                  </div>
                ) : null}

                <TabsContent value="auto" className="space-y-4">
                  <div ref={autoIndexStepRef} className="scroll-mt-4 space-y-4">
                    <IndexLoadPanel
                      workItemTypes={workItemTypes}
                      states={states}
                      workItemTypeOptions={workItemMetadata?.workItemTypes ?? []}
                      stateOptions={workItemMetadata?.states ?? []}
                      metadataLoading={workItemMetadataLoading}
                      metadataError={workItemMetadataError}
                      canLoad={canLoadIndex}
                      loading={buildLoading}
                      onWorkItemTypesChange={changeWorkItemTypes}
                      onStatesChange={changeStates}
                      onRetryMetadata={retryWorkItemMetadata}
                      onLoad={loadProjectIndexForBuild}
                    />

                    {result ? (
                      <>
                        <IndexSummary result={result} />
                        <IndexedContextPanel
                          items={recentItems}
                          totalCount={totalCount}
                          rangeStart={rangeStart}
                          rangeEnd={rangeEnd}
                          page={page}
                          totalPages={totalPages}
                          sortBy={sortBy}
                          sortDirection={sortDirection}
                          search={contextSearch}
                          loading={statusLoading}
                          emptyMessage="No indexed work items matched the loaded project index."
                          onSearchChange={setContextSearch}
                          onSortChange={changeSort}
                          onPageChange={changePage}
                        />
                      </>
                    ) : null}
                  </div>

                  {result ? (
                    <div ref={autoPrepareStepRef} className="scroll-mt-4 space-y-4">
                      <KnowledgePreparePanel
                        compileMode={compileMode}
                        canPrepare={canPrepareKnowledge && !gen.isRunning}
                        loading={buildLoading || gen.isRunning}
                        onCompileModeChange={changeCompileMode}
                        onPrepare={prepareAutoKnowledge}
                        actionLabel={buildLoading || gen.isRunning ? "Preparing..." : "Prepare Knowledge Preview"}
                      />

                      {gen.status !== "idle" && (gen.status !== "completed" || loadingGame.shouldKeepPanelMounted) ? (
                        <AiGenerationProgress
                          variant="generic"
                          title="Building project knowledge"
                          status={gen.status}
                          elapsedSeconds={gen.elapsedSeconds}
                          error={gen.error}
                          errorMessage={gen.errorMessage}
                          canCancel
                          onCancel={gen.cancel}
                          onRetry={() => {
                            gen.retry()
                            void (generatedDraft ? regenerateAutoKnowledge() : prepareAutoKnowledge())
                          }}
                          loadingGame={loadingGame.panel}
                        />
                      ) : null}

                      {generatedDraft?.alreadyCurrent ? (
                        <div className="space-y-2">
                          {gen.status === "completed" ? (
                            <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} warnings={gen.warnings} />
                          ) : null}
                          <GeneratedPreviewPanel
                            draft={generatedDraft}
                            saving={generatedSaveLoading}
                            regenerating={buildLoading || gen.isRunning || loadingGame.shouldKeepPanelMounted}
                            onSave={saveGeneratedKnowledge}
                            onResolve={resolveGeneratedKnowledgeDraft}
                            onLoadReviewContext={loadKnowledgeReviewContext}
                            onRebase={rebaseGeneratedKnowledgeDraft}
                            onRegenerate={regenerateAutoKnowledge}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {generatedDraft && !generatedDraft.alreadyCurrent ? (
                    <div ref={autoPreviewStepRef} className="scroll-mt-4 space-y-2">
                      {gen.status === "completed" ? (
                        <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} warnings={gen.warnings} />
                      ) : null}
                      <GeneratedPreviewPanel
                        draft={generatedDraft}
                        saving={generatedSaveLoading}
                        regenerating={buildLoading || gen.isRunning || loadingGame.shouldKeepPanelMounted}
                        onSave={saveGeneratedKnowledge}
                        onResolve={resolveGeneratedKnowledgeDraft}
                        onLoadReviewContext={loadKnowledgeReviewContext}
                        onRebase={rebaseGeneratedKnowledgeDraft}
                        onRegenerate={regenerateAutoKnowledge}
                      />
                    </div>
                  ) : null}
                </TabsContent>

                <TabsContent value="manual" className="space-y-4">
                  <div ref={manualIndexStepRef} className="scroll-mt-4 space-y-4">
                    <IndexLoadPanel
                      workItemTypes={workItemTypes}
                      states={states}
                      workItemTypeOptions={workItemMetadata?.workItemTypes ?? []}
                      stateOptions={workItemMetadata?.states ?? []}
                      metadataLoading={workItemMetadataLoading}
                      metadataError={workItemMetadataError}
                      canLoad={canLoadIndex}
                      loading={buildLoading}
                      onWorkItemTypesChange={changeWorkItemTypes}
                      onStatesChange={changeStates}
                      onRetryMetadata={retryWorkItemMetadata}
                      onLoad={loadProjectIndexForBuild}
                    />

                    {result ? (
                      <>
                        <IndexSummary result={result} />
                        <IndexedContextPanel
                          items={recentItems}
                          totalCount={totalCount}
                          rangeStart={rangeStart}
                          rangeEnd={rangeEnd}
                          page={page}
                          totalPages={totalPages}
                          sortBy={sortBy}
                          sortDirection={sortDirection}
                          search={contextSearch}
                          loading={statusLoading}
                          emptyMessage="No indexed work items matched the loaded project index."
                          onSearchChange={setContextSearch}
                          onSortChange={changeSort}
                          onPageChange={changePage}
                        />
                      </>
                    ) : null}
                  </div>

                  {result ? (
                    <div ref={manualPrepareStepRef} className="scroll-mt-4 space-y-4">
                      <KnowledgePreparePanel
                        compileMode={compileMode}
                        canPrepare={canPrepareKnowledge}
                        loading={buildLoading}
                        onCompileModeChange={changeCompileMode}
                        onPrepare={prepareExternalKnowledge}
                        actionLabel={buildLoading ? "Preparing prompt..." : "Prepare Knowledge Preview Prompt"}
                      />

                      {manualKnowledgeDraft && buildStep === "prepare" ? (
                        <ExternalPromptPanel
                          draft={manualKnowledgeDraft}
                          currentBatch={currentManualKnowledgeBatch}
                          responses={manualKnowledgeBatchResponses}
                          validatedCount={manualKnowledgeValidatedCount}
                          allValidated={manualKnowledgeAllBatchesValidated}
                          validationLoading={manualKnowledgeValidationLoading}
                          saveLoading={manualKnowledgeSaveLoading}
                          regenerating={buildLoading}
                          validatedBatches={manualKnowledgeValidatedBatches}
                          reviewDraft={manualKnowledgeReviewDraft}
                          batchRef={manualBatchRef}
                          showPrompt
                          showPreview={false}
                          onResponseChange={(batchIndex, value) => {
                            setHasUnfinishedWork(true)
                            setManualKnowledgeBatchResponses((current) => ({
                              ...current,
                              [batchIndex]: value,
                            }))
                          }}
                          onValidate={validateManualKnowledgeBatch}
                          onSave={saveManualKnowledgeBatches}
                          onResolve={resolveManualKnowledgeDraft}
                          onLoadReviewContext={loadKnowledgeReviewContext}
                          onRebase={rebaseManualKnowledgeDraft}
                          onRegenerate={regenerateExternalKnowledge}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {manualKnowledgeDraft && buildStep === "preview" ? (
                    <div ref={manualPreviewStepRef} className="scroll-mt-4">
                      <ExternalPromptPanel
                        draft={manualKnowledgeDraft}
                        currentBatch={currentManualKnowledgeBatch}
                        responses={manualKnowledgeBatchResponses}
                        validatedCount={manualKnowledgeValidatedCount}
                        allValidated={manualKnowledgeAllBatchesValidated}
                        validationLoading={manualKnowledgeValidationLoading}
                        saveLoading={manualKnowledgeSaveLoading}
                        regenerating={buildLoading}
                        validatedBatches={manualKnowledgeValidatedBatches}
                        reviewDraft={manualKnowledgeReviewDraft}
                        batchRef={manualBatchRef}
                        showPrompt={false}
                        showPreview
                        onResponseChange={(batchIndex, value) => {
                          setHasUnfinishedWork(true)
                          setManualKnowledgeBatchResponses((current) => ({
                            ...current,
                            [batchIndex]: value,
                          }))
                        }}
                        onValidate={validateManualKnowledgeBatch}
                        onSave={saveManualKnowledgeBatches}
                        onResolve={resolveManualKnowledgeDraft}
                        onLoadReviewContext={loadKnowledgeReviewContext}
                        onRebase={rebaseManualKnowledgeDraft}
                        onRegenerate={regenerateExternalKnowledge}
                      />
                    </div>
                  ) : null}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </TabsContent>
        ) : null}
      </Tabs>
    </div>
  )
}

function HubSummary({
  activeSourceCount,
  totalKnowledgeItems,
  snapshot,
  loading,
}: {
  activeSourceCount: number
  totalKnowledgeItems: number
  snapshot: ProjectKnowledgeSnapshot | null
  loading: boolean
}) {
  return (
    <Card className="qa-card" aria-busy={loading}>
      <CardContent className="p-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <MetricPanel label="Active source work items" value={activeSourceCount} icon={Database} />
          <MetricPanel label="Knowledge base items" value={totalKnowledgeItems} icon={BookOpen} loading={loading} />
          <MetricPanel label="Last extracted" value={formatDate(snapshot?.extractedAt)} icon={Clock3} className="sm:col-span-2 xl:col-span-1" />
        </div>
      </CardContent>
    </Card>
  )
}

function MetricPanel({
  label,
  value,
  icon: Icon,
  loading = false,
  className,
}: {
  label: string
  value: number | string
  icon: LucideIcon
  loading?: boolean
  className?: string
}) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3 ${className ?? ""}`}>
      <div className="min-w-0">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        {loading ? <Skeleton className="mt-2 h-7 w-20" /> : <div className="mt-1 truncate text-xl font-semibold tabular-nums text-foreground">{value}</div>}
      </div>
      <div className="rounded-lg border border-primary/20 bg-primary/10 p-2 text-primary">
        <Icon className="size-4" aria-hidden="true" />
      </div>
    </div>
  )
}

function HubViewTab({
  value,
  label,
  shortLabel,
  count,
}: {
  value: HubView
  label: string
  shortLabel: string
  count: number | string
}) {
  return (
    <TabsTrigger
      value={value}
      aria-label={`${label}, ${count} items`}
      className="relative h-auto min-w-0 gap-1.5 rounded-none border-0 px-1 py-3 text-sm font-medium text-muted-foreground transition-colors duration-ui hover:text-foreground after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-primary after:opacity-0 group-data-horizontal/tabs:after:bottom-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-primary data-[state=active]:shadow-none data-[state=active]:after:opacity-100 sm:flex-none sm:gap-2"
    >
      <span className="min-w-0 truncate sm:hidden">{shortLabel}</span>
      <span className="hidden min-w-0 truncate sm:inline">{label}</span>
      <Badge variant="secondary" className="shrink-0 px-1.5 tabular-nums">{count}</Badge>
    </TabsTrigger>
  )
}

function BuildStepper({ step }: { step: BuildStep }) {
  const steps = [
    {
      id: "index",
      label: "Load Project Index",
      description: "Select and sync source work items.",
      icon: Database,
    },
    {
      id: "prepare",
      label: "Prepare Knowledge Preview",
      description: "Compile source-backed project knowledge.",
      icon: BookOpen,
    },
    {
      id: "preview",
      label: "Preview & Save",
      description: "Inspect and save the prepared knowledge.",
      icon: Save,
    },
  ] as const
  const activeIndex = steps.findIndex((item) => item.id === step)

  return (
    <WorkflowStepper
      steps={steps}
      activeStepId={step}
      completedStepIds={steps.slice(0, activeIndex).map((item) => item.id)}
      enabledStepIds={[step]}
      ariaLabel="Build Knowledge workflow"
    />
  )
}

function IndexLoadPanel({
  workItemTypes,
  states,
  workItemTypeOptions,
  stateOptions,
  metadataLoading,
  metadataError,
  canLoad,
  loading,
  onWorkItemTypesChange,
  onStatesChange,
  onRetryMetadata,
  onLoad,
}: {
  workItemTypes: string[]
  states: string[]
  workItemTypeOptions: string[]
  stateOptions: string[]
  metadataLoading: boolean
  metadataError: string | null
  canLoad: boolean
  loading: boolean
  onWorkItemTypesChange: (values: string[]) => void
  onStatesChange: (values: string[]) => void
  onRetryMetadata: () => void
  onLoad: () => void
}) {
  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1 space-y-4">
          <ContextFilterSelector
            title="Work item types"
            description="Load matching Azure DevOps work items into the indexed project context before building knowledge."
            options={workItemTypeOptions}
            selectedValues={workItemTypes}
            loading={metadataLoading}
            error={metadataError}
            searchPlaceholder="Search work item types"
            emptyMessage="No work item types were returned for this project."
            onRetry={onRetryMetadata}
            onChange={onWorkItemTypesChange}
          />
          <ContextFilterSelector
            title="States"
            description="Only active source work items in these states are used for knowledge building."
            options={stateOptions}
            selectedValues={states}
            loading={metadataLoading}
            error={metadataError}
            searchPlaceholder="Search states"
            emptyMessage="No work item states were returned for this project."
            onRetry={onRetryMetadata}
            onChange={onStatesChange}
          />
        </div>
        <div className="rounded-md border border-border bg-muted p-3 lg:w-[360px]">
          <div className="mb-3 text-xs leading-5 text-muted-foreground">
            This step syncs the selected source work items and refreshes the retrieval index used by knowledge preparation.
          </div>
          <Button className="h-11 w-full justify-center" onClick={onLoad} disabled={!canLoad} aria-busy={loading}>
            {loading ? <RefreshCw className="size-4 animate-spin" /> : <Database className="size-4" />}
            {loading ? "Loading..." : "Load Project Index"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function KnowledgePreparePanel({
  compileMode,
  canPrepare,
  loading,
  onCompileModeChange,
  onPrepare,
  actionLabel,
}: {
  compileMode: KnowledgeCompileMode
  canPrepare: boolean
  loading: boolean
  onCompileModeChange: (mode: KnowledgeCompileMode) => void
  onPrepare: () => void
  actionLabel: string
}) {
  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <Label className="text-sm font-semibold text-foreground">Compile mode</Label>
          <div className="mt-2 grid gap-2 rounded-md border border-border bg-muted p-1 sm:grid-cols-2">
            <button
              type="button"
              aria-pressed={compileMode === "incremental"}
              className={`rounded-md border px-3 py-2 text-sm font-semibold outline-none transition-colors duration-ui focus-visible:ring-2 focus-visible:ring-ring ${
                compileMode === "incremental"
                  ? "border-primary bg-accent text-primary shadow-sm"
                  : "border-transparent bg-card text-foreground hover:border-primary/40 hover:bg-accent"
              }`}
              onClick={() => onCompileModeChange("incremental")}
            >
              Incremental
            </button>
            <button
              type="button"
              aria-pressed={compileMode === "full"}
              className={`rounded-md border px-3 py-2 text-sm font-semibold outline-none transition-colors duration-ui focus-visible:ring-2 focus-visible:ring-ring ${
                compileMode === "full"
                  ? "border-primary bg-accent text-primary shadow-sm"
                  : "border-transparent bg-card text-foreground hover:border-primary/40 hover:bg-accent"
              }`}
              onClick={() => onCompileModeChange("full")}
            >
              Full recompile
            </button>
          </div>
          <div className="mt-2 text-xs leading-5 text-muted-foreground">
            Prepare the knowledge preview from the project index loaded in step 1.
          </div>
        </div>
        <div className="rounded-md border border-border bg-muted p-3 lg:w-[360px]">
          <div className="mb-3 text-xs leading-5 text-muted-foreground">
            Review the compile mode, then prepare the next knowledge preview.
          </div>
          <Button className="h-11 w-full justify-center" onClick={onPrepare} disabled={!canPrepare} aria-busy={loading}>
            {loading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function KnowledgeDraftGate({
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
}: {
  draftId: string
  status: string
  blockers: ProjectKnowledgeDraftBlocker[]
  reviewSummary: ProjectKnowledgeReviewSummary
  regenerateRequired?: boolean
  proposedKnowledge: ProjectKnowledgeBase | null
  busy: boolean
  onLoadReviewContext: (draftId: string) => Promise<ProjectKnowledgeReviewContext>
  onResolve: (knowledgeBase: ProjectKnowledgeBase) => Promise<void>
  onRebase: () => Promise<void>
  onRegenerate: () => Promise<void>
}) {
  return (
    <KnowledgeReviewWorkspace
      draftId={draftId}
      status={status}
      blockers={blockers}
      reviewSummary={reviewSummary}
      regenerateRequired={regenerateRequired}
      proposedKnowledge={proposedKnowledge as import("@/modules/rag/project-knowledge.schema").ProjectKnowledgeBase | null}
      busy={busy}
      onLoadReviewContext={() => onLoadReviewContext(draftId)}
      onResolve={onResolve}
      onRebase={onRebase}
      onRegenerate={onRegenerate}
    />
  )
}

export function knowledgePublishBlockedReason({
  status,
  blockerCount,
  regenerateRequired,
}: {
  status: string | null
  blockerCount: number
  regenerateRequired?: boolean
}) {
  if (blockerCount > 0) {
    return `Blocked: ${blockerCount} review ${blockerCount === 1 ? "issue remains" : "issues remain"}.`
  }
  if (regenerateRequired) {
    return "Blocked: Source changes require refreshing sources and regenerating this draft."
  }
  if (status !== "ready_for_review") {
    return "Blocked: Complete and re-check the review before publishing."
  }
  return null
}

function GeneratedPreviewPanel({
  draft,
  saving,
  regenerating,
  onSave,
  onLoadReviewContext,
  onResolve,
  onRebase,
  onRegenerate,
}: {
  draft: KnowledgeGeneratedDraft
  saving: boolean
  regenerating: boolean
  onSave: () => void
  onLoadReviewContext: (draftId: string) => Promise<ProjectKnowledgeReviewContext>
  onResolve: (knowledgeBase: ProjectKnowledgeBase) => Promise<KnowledgePersistedDraft | void>
  onRebase: () => Promise<void>
  onRegenerate: () => Promise<void>
}) {
  const isIncremental = draft.mode === "incremental"
  const displayBase = useMemo(
    () =>
      isIncremental
        ? filterKnowledgeBaseBySource(draft.knowledgeBase, new Set(draft.changedSourceWorkItemIds))
        : draft.knowledgeBase,
    [isIncremental, draft.knowledgeBase, draft.changedSourceWorkItemIds],
  )
  const totalItems = countKnowledgeItems(draft.knowledgeBase)
  const displayCount = countKnowledgeItems(displayBase)
  const canPublish = draft.draftStatus === "ready_for_review" && draft.blockers.length === 0 && !draft.regenerateRequired
  const publishBlockedReason = regenerating
    ? "Refreshing sources and regenerating the draft. Your current draft will remain available until its replacement is ready."
    : knowledgePublishBlockedReason({
        status: draft.draftStatus,
        blockerCount: draft.blockers.length,
        regenerateRequired: draft.regenerateRequired,
      })
  const publishReasonId = `generated-publish-reason-${draft.draftId}`
  const [highlightedEntryIdentities, setHighlightedEntryIdentities] = useState<string[]>([])

  useEffect(() => {
    setHighlightedEntryIdentities([])
  }, [draft.draftId])

  async function resolveAndHighlight(proposedKnowledge: ProjectKnowledgeBase) {
    const changedEntries = changedKnowledgeEntryIdentities(draft.knowledgeBase, proposedKnowledge)
    const resolved = await onResolve(proposedKnowledge)
    const resolvedStatus = resolved ? resolved.persistedStatus ?? resolved.status : null
    if (resolved && resolvedStatus === "ready_for_review" && !resolved.blockers.length && !resolved.regenerateRequired) {
      setHighlightedEntryIdentities(changedEntries)
    }
  }

  if (draft.alreadyCurrent) {
    return (
      <div className="rounded-md border border-success/30 bg-success/10 p-4 text-sm text-success">
        <div className="font-semibold">No Knowledge Changes Needed</div>
        <div className="mt-1">
          The current incremental baseline has no changed work items, so there is no generated preview to save.
        </div>
      </div>
    )
  }

  const showRetiredOnlyNote = isIncremental && displayCount === 0

  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground" role="heading" aria-level={3}>Generated Knowledge Preview</div>
          <div className="text-xs text-muted-foreground">
            {isIncremental ? (
              <>
                {displayCount} new/updated {displayCount === 1 ? "entry" : "entries"} from {draft.changedSourceWorkItemCount} changed source work {draft.changedSourceWorkItemCount === 1 ? "item" : "items"}. {draft.retiredSourceWorkItemCount} retired. Saving updates the full knowledge base ({totalItems} entries total).
              </>
            ) : (
              <>{totalItems} entries from {draft.sourceWorkItemCount} active source work items.</>
            )}
          </div>
        </div>
        <Badge variant="outline">Prompt {draft.promptVersion}</Badge>
      </div>
      {draft.fallbackReason ? (
        <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-xs text-warning-foreground dark:text-warning">
          {draft.fallbackReason}
        </div>
      ) : null}
      {showRetiredOnlyNote ? (
        <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          No new or updated knowledge entries were generated.
          {draft.retiredSourceWorkItemCount > 0
            ? ` ${draft.retiredSourceWorkItemCount} retired source work item${
                draft.retiredSourceWorkItemCount === 1 ? "" : "s"
              } will be pruned from the saved knowledge base on save.`
            : ""}
        </div>
      ) : (
        <KnowledgeExplorer knowledgeBase={displayBase} compact highlightedEntryIdentities={highlightedEntryIdentities} />
      )}
      <KnowledgeDraftGate
        draftId={draft.draftId}
        status={draft.draftStatus}
        blockers={draft.blockers}
        reviewSummary={draft.reviewSummary}
        regenerateRequired={draft.regenerateRequired}
        proposedKnowledge={draft.knowledgeBase}
        busy={saving || regenerating}
        onLoadReviewContext={onLoadReviewContext}
        onResolve={resolveAndHighlight}
        onRebase={onRebase}
        onRegenerate={onRegenerate}
      />
      <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center">
        {publishBlockedReason ? (
          <p id={publishReasonId} className="text-xs leading-5 text-muted-foreground">
            {publishBlockedReason}
          </p>
        ) : null}
        <Button
          className="sm:ml-auto"
          onClick={onSave}
          disabled={saving || regenerating || !canPublish}
          aria-busy={saving || regenerating}
          aria-describedby={publishBlockedReason ? publishReasonId : undefined}
        >
          {saving || regenerating ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Save className="size-4" />}
          {regenerating ? "Refreshing draft..." : saving ? "Publishing..." : "Publish Knowledge Base"}
        </Button>
      </div>
    </div>
  )
}

function ExternalPromptPanel({
  draft,
  currentBatch,
  responses,
  validatedCount,
  allValidated,
  validationLoading,
  saveLoading,
  regenerating,
  validatedBatches,
  reviewDraft,
  batchRef,
  showPrompt = true,
  showPreview = true,
  onResponseChange,
  onValidate,
  onSave,
  onLoadReviewContext,
  onResolve,
  onRebase,
  onRegenerate,
}: {
  draft: KnowledgeManualDraft
  currentBatch?: KnowledgeManualBatchPrompt
  responses: Record<number, string>
  validatedCount: number
  allValidated: boolean
  validationLoading: boolean
  saveLoading: boolean
  regenerating: boolean
  validatedBatches: Record<number, ProjectKnowledgeBase>
  reviewDraft: KnowledgePersistedDraft | null
  batchRef: RefObject<HTMLDivElement | null>
  showPrompt?: boolean
  showPreview?: boolean
  onResponseChange: (batchIndex: number, value: string) => void
  onValidate: () => void
  onSave: () => void
  onLoadReviewContext: (draftId: string) => Promise<ProjectKnowledgeReviewContext>
  onResolve: (knowledgeBase: ProjectKnowledgeBase) => Promise<KnowledgePersistedDraft | void>
  onRebase: () => Promise<void>
  onRegenerate: () => Promise<void>
}) {
  const hasRetiredOnlyUpdate = draft.batchCount === 0 && draft.retiredSourceWorkItemCount > 0
  const previewKnowledgeBase = useMemo(() => {
    const reviewed = reviewDraft?.proposedKnowledge ?? reviewDraft?.knowledgeBase
    if (reviewed) return reviewed
    const bases = Object.values(validatedBatches)
    if (bases.length === 1) return bases[0]
    if (!bases.length) return null
    return combineKnowledgeBasesForPreview(bases)
  }, [reviewDraft, validatedBatches])
  const reviewStatus = reviewDraft ? reviewDraft.persistedStatus ?? reviewDraft.status : null
  const canPublishReview = reviewStatus === "ready_for_review" && !reviewDraft?.blockers.length && !reviewDraft?.regenerateRequired
  const actionLabel = reviewDraft ? "Publish Knowledge Base" : "Create Review Draft"
  const publishBlockedReason = regenerating
    ? "Refreshing sources and regenerating the draft. Your current draft will remain available until its replacement is ready."
    : reviewDraft
      ? knowledgePublishBlockedReason({
          status: reviewStatus,
          blockerCount: reviewDraft.blockers.length,
          regenerateRequired: reviewDraft.regenerateRequired,
        })
      : null
  const publishReasonId = `manual-publish-reason-${reviewDraft?.id ?? draft.draftId}`
  const [highlightedEntryIdentities, setHighlightedEntryIdentities] = useState<string[]>([])

  useEffect(() => {
    setHighlightedEntryIdentities([])
  }, [draft.draftId, reviewDraft?.id])

  async function resolveAndHighlight(proposedKnowledge: ProjectKnowledgeBase) {
    const changedEntries = previewKnowledgeBase
      ? changedKnowledgeEntryIdentities(previewKnowledgeBase, proposedKnowledge)
      : []
    const resolved = await onResolve(proposedKnowledge)
    const resolvedStatus = resolved ? resolved.persistedStatus ?? resolved.status : null
    if (resolved && resolvedStatus === "ready_for_review" && !resolved.blockers.length && !resolved.regenerateRequired) {
      setHighlightedEntryIdentities(changedEntries)
    }
  }

  if (draft.batchCount === 0) {
    return (
      <div
        className={`rounded-md border p-4 text-sm ${
          hasRetiredOnlyUpdate
            ? "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning"
            : "border-success/30 bg-success/10 text-success"
        }`}
      >
        <div className="font-semibold">
          {hasRetiredOnlyUpdate ? "Knowledge Baseline Update Needed" : "No Knowledge Changes Needed"}
        </div>
        <div className="mt-1">
          {hasRetiredOnlyUpdate
            ? `${draft.retiredSourceWorkItemCount} retired source work item${
                draft.retiredSourceWorkItemCount === 1 ? "" : "s"
              } should be removed from the saved knowledge base. No external prompt is needed.`
            : "The current incremental baseline has no changed work items, so there is no external prompt to copy or save."}
        </div>
        {draft.fallbackReason ? <div className="mt-2 text-xs">{draft.fallbackReason}</div> : null}
        {hasRetiredOnlyUpdate ? (
          <div className="mt-4 space-y-3">
            {reviewDraft ? (
              <KnowledgeDraftGate
                draftId={reviewDraft.id}
                status={reviewStatus ?? reviewDraft.status}
                blockers={reviewDraft.blockers}
                reviewSummary={reviewDraft.reviewSummary}
                regenerateRequired={reviewDraft.regenerateRequired}
                proposedKnowledge={reviewDraft.proposedKnowledge ?? reviewDraft.knowledgeBase ?? null}
                busy={saveLoading || regenerating}
                onLoadReviewContext={onLoadReviewContext}
                onResolve={resolveAndHighlight}
                onRebase={onRebase}
                onRegenerate={onRegenerate}
              />
            ) : null}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {publishBlockedReason ? (
                <p id={publishReasonId} className="text-xs leading-5 text-muted-foreground">
                  {publishBlockedReason}
                </p>
              ) : null}
              <Button
                className="sm:ml-auto"
                onClick={onSave}
                disabled={saveLoading || regenerating || (Boolean(reviewDraft) && !canPublishReview)}
                aria-busy={saveLoading || regenerating}
                aria-describedby={publishBlockedReason ? publishReasonId : undefined}
              >
                {saveLoading || regenerating ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Save className="size-4" />}
                {regenerating ? "Refreshing draft..." : saveLoading ? "Working..." : actionLabel}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {showPrompt ? (
        <div className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="font-semibold text-foreground">
                {draft.mode === "incremental" ? "Compile Knowledge Prompt" : "Full Recompile Prompt"}
              </div>
              <div className="text-xs text-muted-foreground">
                {draft.sourceWorkItemCount} of {draft.totalSourceWorkItemCount} active work items in prompt input.
                {draft.mode === "incremental"
                  ? ` ${draft.changedSourceWorkItemCount} changed, ${draft.retiredSourceWorkItemCount} retired.`
                  : null}
              </div>
            </div>
            <Badge variant="outline">{draft.batchCount} {draft.batchCount === 1 ? "batch" : "batches"}</Badge>
          </div>
          {draft.fallbackReason ? (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/15 p-3 text-xs text-warning-foreground dark:text-warning">
              {draft.fallbackReason}
            </div>
          ) : null}
        </div>
      ) : null}

      {showPrompt && currentBatch ? (
        <div ref={batchRef} className="space-y-4 rounded-md border border-border bg-muted p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">
                Batch {currentBatch.batchIndex} of {draft.batchCount}
              </div>
              <div className="text-xs text-muted-foreground">
                {currentBatch.workItemCount} work items in this prompt. {validatedCount} validated.
              </div>
            </div>
          </div>
          <ManualLLMFields
            key={currentBatch.batchIndex}
            prompt={currentBatch.prompt}
            response={responses[currentBatch.batchIndex] ?? ""}
            onResponseChange={(value) => onResponseChange(currentBatch.batchIndex, value)}
            onSubmit={onValidate}
            submitting={validationLoading}
            submitLabel="Validate Batch"
            submittingLabel="Validating..."
            responseLabel="External LLM Response"
            responsePlaceholder="Paste the JSON response for this batch."
            promptMinHeightClass="min-h-[320px]"
            responseMinHeightClass="min-h-[220px]"
          />
        </div>
      ) : null}

      {showPreview && allValidated && previewKnowledgeBase ? (
        <div className="space-y-4 rounded-md border border-border bg-card p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">Validated Knowledge Preview</div>
              <div className="text-xs text-muted-foreground">
                {validatedCount} batch {validatedCount === 1 ? "response" : "responses"} validated. Save to persist the final knowledge base.
              </div>
            </div>
            <Badge variant="outline">{countKnowledgeItems(previewKnowledgeBase)} entries</Badge>
          </div>
          <KnowledgeExplorer knowledgeBase={previewKnowledgeBase} compact highlightedEntryIdentities={highlightedEntryIdentities} />
          {reviewDraft ? (
            <KnowledgeDraftGate
              draftId={reviewDraft.id}
              status={reviewStatus ?? reviewDraft.status}
              blockers={reviewDraft.blockers}
              reviewSummary={reviewDraft.reviewSummary}
              regenerateRequired={reviewDraft.regenerateRequired}
              proposedKnowledge={reviewDraft.proposedKnowledge ?? reviewDraft.knowledgeBase ?? null}
              busy={saveLoading || regenerating}
              onLoadReviewContext={onLoadReviewContext}
              onResolve={resolveAndHighlight}
              onRebase={onRebase}
              onRegenerate={onRegenerate}
            />
          ) : (
            <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
              Finalization creates a persisted review draft. Publishing is a separate explicit action.
            </div>
          )}
          <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center">
            {publishBlockedReason ? (
              <p id={publishReasonId} className="text-xs leading-5 text-muted-foreground">
                {publishBlockedReason}
              </p>
            ) : null}
            <Button
              className="sm:ml-auto"
              onClick={onSave}
              disabled={saveLoading || regenerating || (Boolean(reviewDraft) && !canPublishReview)}
              aria-busy={saveLoading || regenerating}
              aria-describedby={publishBlockedReason ? publishReasonId : undefined}
            >
              {saveLoading || regenerating ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" /> : <Save className="size-4" />}
              {regenerating ? "Refreshing draft..." : saveLoading ? "Working..." : actionLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function SortHeader({
  label,
  active,
  direction,
  onClick,
}: {
  label: string
  active: boolean
  direction: ContextSortDirection
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 px-2 text-foreground"
      onClick={onClick}
      aria-label={`Sort by ${label}${active ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      {label}
      <ArrowUpDown className="size-3.5" />
      {active ? <span className="text-xs text-muted-foreground">{direction === "asc" ? "Asc" : "Desc"}</span> : null}
    </Button>
  )
}

function IndexedContextPanel(props: IndexedContextViewProps) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <CardTitle className="text-base" role="heading" aria-level={2}>Indexed Project Context</CardTitle>
      </CardHeader>
      <CardContent>
        <IndexedContextView {...props} />
      </CardContent>
    </Card>
  )
}

type IndexedContextViewProps = {
  items: RecentContextItem[]
  totalCount: number
  rangeStart: number
  rangeEnd: number
  page: number
  totalPages: number
  sortBy: ContextSortBy
  sortDirection: ContextSortDirection
  search: string
  loading: boolean
  emptyMessage: string
  onSearchChange: (value: string) => void
  onSortChange: (sortBy: ContextSortBy) => void
  onPageChange: (page: number) => void
}

function IndexedContextView({
  items,
  totalCount,
  rangeStart,
  rangeEnd,
  page,
  totalPages,
  sortBy,
  sortDirection,
  search,
  loading,
  emptyMessage,
  onSearchChange,
  onSortChange,
  onPageChange,
}: IndexedContextViewProps) {
  const safeTotalPages = Math.max(1, totalPages)
  const safePage = Math.min(Math.max(1, page), safeTotalPages)
  const canGoPrevious = safePage > 1
  const canGoNext = safePage < safeTotalPages

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {totalCount > 0
            ? `Showing ${rangeStart}-${rangeEnd} of ${totalCount} active source work items available for retrieval.`
            : search.trim()
              ? "No active source work items match the current search."
              : "No active source work items are available for retrieval yet."}
        </div>
        <div className="relative w-full lg:w-[360px]">
          <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            className="pl-8"
            placeholder="Search ID, title, or indexed text"
            aria-label="Search indexed project context"
          />
        </div>
      </div>

      {!items.length && loading ? (
        <KnowledgeLoadingState label="Loading indexed project context" compact />
      ) : items.length ? (
        <div className="space-y-3">
          <div className="content-scroll-region">
            <Table className={`min-w-[760px] ${loading ? "opacity-60" : ""}`}>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead aria-sort={sortBy === "type" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
                    <SortHeader label="Type" active={sortBy === "type"} direction={sortDirection} onClick={() => onSortChange("type")} />
                  </TableHead>
                  <TableHead className="min-w-[320px]">Title</TableHead>
                  <TableHead className="text-right">Chunks</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead aria-sort={sortBy === "lastIndexedAt" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
                    <SortHeader
                      label="Last Indexed"
                      active={sortBy === "lastIndexedAt"}
                      direction={sortDirection}
                      onClick={() => onSortChange("lastIndexedAt")}
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.workItemId}>
                    <TableCell className="font-mono text-xs font-semibold tabular-nums text-primary">{item.workItemId}</TableCell>
                    <TableCell><Badge variant="secondary">{item.workItemType}</Badge></TableCell>
                    <TableCell className="max-w-[420px] truncate font-medium text-foreground" title={item.title}>{item.title}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{item.chunkCount}</TableCell>
                    <TableCell><Badge variant="outline" className={`capitalize ${syncStatusToneClass(item.syncStatus)}`}>{item.syncStatus ?? "active"}</Badge></TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{formatDate(item.lastIndexedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Page {safePage} of {safeTotalPages}
              {loading ? " - Loading" : ""}
            </span>
            <div className="flex gap-2">
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!canGoPrevious || loading}
                onClick={() => onPageChange(safePage - 1)}
                aria-label="Previous page"
                title="Previous page"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="outline"
                disabled={!canGoNext || loading}
                onClick={() => onPageChange(safePage + 1)}
                aria-label="Next page"
                title="Next page"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <KnowledgeEmptyState
          title={search.trim() ? "No indexed work items match" : "No indexed project context"}
          message={search.trim() ? "Try a broader title, work item ID, or indexed-text search." : emptyMessage}
          actionLabel={search.trim() ? "Clear search" : undefined}
          onAction={search.trim() ? () => onSearchChange("") : undefined}
          compact
        />
      )}
    </>
  )
}

function IndexSummary({ result }: { result: IndexResult }) {
  const metrics = [
    ["Fetched", result.fetchedCount],
    ["New", result.createdCount],
    ["Updated", result.updatedCount],
    ["Unchanged", result.unchangedCount],
    ["Inactive", result.inactiveCount],
    ["Reindexed", result.indexedWorkItemCount],
    ["Chunks indexed", result.indexedChunkCount],
    ["Skipped empty", result.skippedEmptyCount],
  ] as const

  return (
    <Card className="qa-card">
      <CardHeader>
        <CardTitle className="text-base" role="heading" aria-level={2}>Latest Indexing Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-md border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 text-base font-semibold tabular-nums text-foreground">{value}</div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 text-sm text-muted-foreground lg:grid-cols-2">
          <div><span className="font-semibold">Mode:</span> {result.mode}</div>
          <div><span className="font-semibold">Types:</span> {result.workItemTypes.join(", ")}</div>
          <div><span className="font-semibold">States:</span> {result.states.join(", ")}</div>
        </div>
      </CardContent>
    </Card>
  )
}

export function KnowledgeCandidatesView({
  candidates,
  status,
  loading,
  canManage,
  onStatusChange,
  onAction,
}: {
  candidates: KnowledgeCandidate[]
  status: KnowledgeCandidateStatus | "all"
  loading: boolean
  canManage: boolean
  onStatusChange: (status: KnowledgeCandidateStatus | "all") => void
  onAction: (candidateId: string, action: "reject" | "request_integration") => Promise<void>
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Knowledge Candidates</div>
          <div className="text-xs text-muted-foreground">Candidate answers remain non-authoritative until integrated through a reviewed draft.</div>
        </div>
        <Label className="space-y-1 text-xs sm:w-56">
          <span>Status</span>
          <select
            value={status}
            onChange={(event) => onStatusChange(event.target.value as KnowledgeCandidateStatus | "all")}
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
          >
            <option value="all">All statuses</option>
            <option value="legacy_ungrounded">Legacy ungrounded</option>
            <option value="grounded">Grounded</option>
            <option value="integration_requested">Integration requested</option>
            <option value="rejected">Rejected</option>
          </select>
        </Label>
      </div>
      {loading ? <KnowledgeLoadingState label="Loading knowledge candidates" /> : candidates.length ? candidates.map((candidate) => (
        <div key={candidate.id} className="rounded-md border border-border bg-card p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{candidate.status.replaceAll("_", " ")}</Badge>
            <span className="font-semibold text-foreground">{candidate.title}</span>
          </div>
          <div className="mt-2 whitespace-pre-wrap text-muted-foreground">{candidate.content}</div>
          <div className="mt-3 text-xs text-muted-foreground">Sources: {candidate.sourceWorkItemIds.join(", ") || "No linked work items"}</div>
          {candidate.evidenceRefs.length || candidate.citations.length ? (
            <details className="mt-3 rounded-md bg-muted p-3">
              <summary className="cursor-pointer text-xs font-semibold">Evidence and citations</summary>
              <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ evidenceRefs: candidate.evidenceRefs, citations: candidate.citations }, null, 2)}</pre>
            </details>
          ) : null}
          {candidate.rejectedReason ? <div className="mt-2 text-xs text-destructive">Rejected: {candidate.rejectedReason}</div> : null}
          {canManage && !["rejected", "integration_requested"].includes(candidate.status) ? (
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={loading} onClick={() => void onAction(candidate.id, "reject")}>Reject</Button>
              {candidate.status === "grounded" ? (
                <Button size="sm" disabled={loading} onClick={() => void onAction(candidate.id, "request_integration")}>Request Integration</Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )) : <KnowledgeEmptyState title="No candidates" message="No knowledge candidates match this status." />}
    </div>
  )
}

export function KnowledgeGovernanceView({
  governance,
  loading,
  canManage,
  onStart,
  onDecide,
}: {
  governance: KnowledgeGovernance | null
  loading: boolean
  canManage: boolean
  onStart: () => Promise<void>
  onDecide: (adrId: string, decision: string) => Promise<void>
}) {
  const [decisions, setDecisions] = useState<Record<string, string>>({})
  if (loading && !governance) return <KnowledgeLoadingState label="Loading compiler governance" />
  if (!governance) return <KnowledgeEmptyState title="Governance unavailable" message="Compiler governance metrics could not be loaded." />
  const gates = [
    ["Richer synthesis", governance.gates.richerSynthesisEligible],
    ["LLM semantic lint", governance.gates.semanticLintEligible],
    ["Candidate acceptance", governance.gates.candidateAcceptanceEligible],
  ] as const
  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Milestone 3 GA Measurement</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {governance.rollout.milestone3GaAt
                ? `Started ${formatDate(governance.rollout.milestone3GaAt)}`
                : "Not started. Publications are not counted until an owner starts the clock."}
            </div>
          </div>
          {canManage && !governance.rollout.milestone3GaAt ? <Button size="sm" onClick={() => void onStart()}>Start Milestone 3 GA</Button> : null}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <KnowledgeMetric label="Publications" value={governance.rollout.reconciliationPublicationCount} />
          <KnowledgeMetric label="Measured drafts" value={governance.rollout.measuredDraftCount} />
          <KnowledgeMetric label="Evaluation ready" value={governance.rollout.evaluationReady ? "Yes" : "No"} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {gates.map(([label, eligible]) => <KnowledgeMetric key={label} label={label} value={eligible ? "Eligible" : "Deferred"} />)}
      </div>
      <div className="rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground">
        Quote-fidelity and unknown-model fallback checkpoints create ADR review items here when their measured thresholds are crossed.
      </div>
      <div className="space-y-2">
        <div className="text-sm font-semibold text-foreground">Architecture Decision Records</div>
        {governance.adrs.length ? governance.adrs.map((adr) => (
          <div key={adr.id} className="rounded-md border border-border bg-card p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{adr.status}</Badge><span className="font-semibold">{adr.type.replaceAll("_", " ")}</span></div>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{JSON.stringify(adr.metricSnapshot, null, 2)}</pre>
            {adr.decision ? <div className="mt-2 text-sm">Decision: {adr.decision}</div> : canManage ? (
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Input value={decisions[adr.id] ?? ""} onChange={(event) => setDecisions((current) => ({ ...current, [adr.id]: event.target.value }))} placeholder="Record the owner decision" maxLength={4000} />
                <Button size="sm" disabled={!decisions[adr.id]?.trim()} onClick={() => void onDecide(adr.id, decisions[adr.id] ?? "")}>Record decision</Button>
              </div>
            ) : null}
          </div>
        )) : <div className="text-sm text-muted-foreground">No monitoring ADRs have been created.</div>}
      </div>
    </div>
  )
}

function KnowledgeOpsPanel({
  lint,
  logItems,
  logVisible,
  exportResult,
  healthLoading,
  logLoading,
  exportLoading,
  canManage,
  onRunHealthCheck,
  onToggleLog,
  onExport,
  onReportMiss,
  onTransitionIssue,
}: {
  lint: KnowledgeLintResult | null
  logItems: KnowledgeLogItem[]
  logVisible: boolean
  exportResult: KnowledgeExportResult | null
  healthLoading: boolean
  logLoading: boolean
  exportLoading: boolean
  canManage: boolean
  onRunHealthCheck: () => void
  onToggleLog: () => void
  onExport: () => void
  onReportMiss: (input: { missType: "duplicate" | "conflict"; title: string; message: string }) => Promise<void>
  onTransitionIssue: (issueId: string, action: "confirm" | "reject" | "ignore" | "reopen") => Promise<void>
}) {
  const [missType, setMissType] = useState<"duplicate" | "conflict">("duplicate")
  const [missTitle, setMissTitle] = useState("")
  const [missMessage, setMissMessage] = useState("")

  async function submitMiss() {
    if (!missTitle.trim() || !missMessage.trim()) return
    await onReportMiss({ missType, title: missTitle.trim(), message: missMessage.trim() })
    setMissTitle("")
    setMissMessage("")
  }

  return (
    <section className="content-surface space-y-3 p-4" aria-label="Compiled knowledge operations">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden="true" />
            <span role="heading" aria-level={2} className="text-sm font-semibold text-foreground">Compiled Knowledge Operations</span>
          </div>
          <div className="text-xs text-muted-foreground">Health checks, event history, and managed export for the source-backed knowledge layer.</div>
        </div>
        <div className="grid grid-cols-2 gap-2 min-[420px]:grid-cols-3 sm:flex sm:flex-wrap lg:shrink-0 lg:flex-nowrap">
          {canManage ? (
            <Button variant="outline" size="sm" onClick={onRunHealthCheck} disabled={healthLoading}>
              {healthLoading ? <RefreshCw className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              <span className="sm:hidden">Health</span>
              <span className="hidden sm:inline">Check health</span>
            </Button>
          ) : null}
          <Button variant={logVisible ? "secondary" : "outline"} size="sm" onClick={onToggleLog} disabled={logLoading} aria-expanded={logVisible}>
            {logLoading ? <RefreshCw className="size-4 animate-spin" /> : <History className="size-4" />}
            <span className="sm:hidden">{logVisible ? "Hide" : "Log"}</span>
            <span className="hidden sm:inline">{logVisible ? "Hide Log" : "Log"}</span>
          </Button>
          {canManage ? (
            <Button variant="outline" size="sm" onClick={onExport} disabled={exportLoading}>
              {exportLoading ? <RefreshCw className="size-4 animate-spin" /> : <Download className="size-4" />}
              <span className="sm:hidden">Export</span>
              <span className="hidden sm:inline">Export files</span>
            </Button>
          ) : null}
        </div>
      </div>

      {lint ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <KnowledgeMetric label="Issues" value={lint.summary.total} />
          <KnowledgeMetric label="Errors" value={lint.summary.errors} tone="error" />
          <KnowledgeMetric label="Warnings" value={lint.summary.warnings} tone="warning" />
          <KnowledgeMetric label="Info" value={lint.summary.info} />
        </div>
      ) : null}

      {lint?.issues.length ? (
        <div className="space-y-2">
          {lint.issues.slice(0, 5).map((issue) => (
            <div key={issue.id} className="rounded-md border border-border bg-muted p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={issue.severity === "error" ? "destructive" : "secondary"}>{issue.severity}</Badge>
                <Badge variant="outline">{issue.status}</Badge>
                <span className="font-semibold text-foreground">{issue.title}</span>
              </div>
              <div className="mt-1 text-muted-foreground">{issue.message}</div>
              {canManage && issue.origin === "human" && issue.status === "reported" ? (
                <div className="mt-3 flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={healthLoading} onClick={() => void onTransitionIssue(issue.id, "reject")}>Reject report</Button>
                  <Button size="sm" disabled={healthLoading} onClick={() => void onTransitionIssue(issue.id, "confirm")}>Confirm miss</Button>
                </div>
              ) : null}
              {canManage && issue.origin === "deterministic" && issue.status === "open" ? (
                <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" disabled={healthLoading} onClick={() => void onTransitionIssue(issue.id, "ignore")}>Ignore</Button></div>
              ) : null}
              {canManage && ((issue.origin === "deterministic" && ["ignored", "resolved"].includes(issue.status)) || (issue.origin === "human" && ["confirmed", "rejected"].includes(issue.status))) ? (
                <div className="mt-3 flex justify-end"><Button size="sm" variant="outline" disabled={healthLoading} onClick={() => void onTransitionIssue(issue.id, "reopen")}>Reopen</Button></div>
              ) : null}
            </div>
          ))}
        </div>
      ) : lint ? (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
          Knowledge health check passed without open issues.
        </div>
      ) : null}

      <div className="space-y-3 rounded-md border border-border bg-muted p-3">
        <div>
          <div className="text-sm font-semibold text-foreground">Report a missed duplicate or conflict</div>
          <div className="text-xs text-muted-foreground">Reports do not change knowledge. Owners or admins must confirm them before they count toward semantic-lint expansion.</div>
        </div>
        <div className="grid gap-3 md:grid-cols-[180px_1fr]">
          <Label className="space-y-1 text-xs">
            <span>Miss type</span>
            <select
              value={missType}
              onChange={(event) => setMissType(event.target.value as "duplicate" | "conflict")}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            >
              <option value="duplicate">Duplicate</option>
              <option value="conflict">Conflict</option>
            </select>
          </Label>
          <Label className="space-y-1 text-xs">
            <span>Title</span>
            <Input value={missTitle} onChange={(event) => setMissTitle(event.target.value)} maxLength={200} placeholder="What deterministic lint missed" />
          </Label>
        </div>
        <Label className="space-y-1 text-xs">
          <span>Evidence and impact</span>
          <Textarea value={missMessage} onChange={(event) => setMissMessage(event.target.value)} maxLength={2000} placeholder="Describe the entries, concrete mismatch, and relevant source IDs." />
        </Label>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => void submitMiss()} disabled={healthLoading || !missTitle.trim() || !missMessage.trim()}>
            {healthLoading ? <RefreshCw className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Report miss
          </Button>
        </div>
      </div>

      {exportResult ? (
        <div className="rounded-md border border-primary/40 bg-accent p-3 text-sm text-primary">
          Exported {exportResult.fileCount} knowledge files to <span className="font-mono">{exportResult.exportRoot}</span>.
        </div>
      ) : null}

      {logVisible ? (
        <div className="space-y-2">
          <div className="text-xs font-semibold uppercase text-muted-foreground">Recent Knowledge Log</div>
          {logItems.length ? (
            logItems.slice(0, 8).map((item) => (
              <div key={item.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{item.eventType}</Badge>
                  <span className="font-semibold text-foreground">{item.title}</span>
                  <span className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</span>
                </div>
                <div className="mt-1 text-muted-foreground">{item.message}</div>
              </div>
            ))
          ) : (
            <div className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
              No knowledge log events have been recorded for this project yet.
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

function KnowledgeMetric({ label, value, tone }: { label: string; value: number | string; tone?: "error" | "warning" }) {
  const valueClass = tone === "error" ? "text-destructive" : tone === "warning" ? "text-warning-foreground dark:text-warning" : "text-foreground"
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-base font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  )
}

function KnowledgeExplorer({
  knowledgeBase,
  compact = false,
  highlightedEntryIdentities = NO_HIGHLIGHTED_KNOWLEDGE_ENTRIES,
}: {
  knowledgeBase: ProjectKnowledgeBase
  compact?: boolean
  highlightedEntryIdentities?: string[]
}) {
  const [category, setCategory] = useState<KnowledgeExplorerCategory>("all")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(1)
  const entries = useMemo(() => flattenKnowledgeEntries(knowledgeBase), [knowledgeBase])
  const counts = useMemo(() => getKnowledgeCategoryCounts(knowledgeBase), [knowledgeBase])
  const normalizedQuery = normalizeSearch(query)
  const filteredEntries = entries.filter((entry) => {
    const categoryMatch = category === "all" || entry.category === category
    const textMatch = !normalizedQuery || normalizeSearch(entry.searchText).includes(normalizedQuery)
    return categoryMatch && textMatch
  })
  const pageSize = compact ? 5 : 8
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = filteredEntries.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const pageEnd = Math.min(filteredEntries.length, safePage * pageSize)
  const visibleEntries = filteredEntries.slice((safePage - 1) * pageSize, safePage * pageSize)

  useEffect(() => {
    setPage(1)
  }, [category, query, compact, knowledgeBase])

  useEffect(() => {
    const highlightedIndex = entries.findIndex((entry) => highlightedEntryIdentities.includes(entry.highlightIdentity))
    if (highlightedIndex < 0) return
    setCategory("all")
    setQuery("")
    setPage(Math.floor(highlightedIndex / pageSize) + 1)
  }, [entries, highlightedEntryIdentities, pageSize])

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {filteredEntries.length} entries match the current filters.
        </div>
        <div className="relative w-full lg:w-[420px]">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search knowledge or source IDs"
            aria-label="Search compiled knowledge"
            className="pl-9"
          />
        </div>
      </div>
      <div className={`grid gap-4 ${compact ? "lg:grid-cols-[180px_1fr]" : "lg:grid-cols-[190px_1fr]"}`}>
        <div className="-mx-1 px-1 lg:mx-0 lg:px-0">
          <div role="group" aria-label="Knowledge categories" className="flex flex-wrap gap-1 lg:block lg:space-y-1">
            <KnowledgeCategoryButton
              label="All"
              count={entries.length}
              active={category === "all"}
              onClick={() => setCategory("all")}
            />
            {KNOWLEDGE_CATEGORIES.map((item) => (
              <KnowledgeCategoryButton
                key={item.key}
                label={item.label}
                count={counts[item.key]}
                active={category === item.key}
                onClick={() => setCategory(item.key)}
              />
            ))}
          </div>
        </div>
        <div className={`space-y-3 ${compact ? "max-h-[520px] overflow-y-auto pr-1" : ""}`}>
          {visibleEntries.length ? (
            visibleEntries.map((entry) => (
              <KnowledgeExplorerEntryCard
                key={entry.key}
                entry={entry}
                compact={compact}
                highlighted={highlightedEntryIdentities.includes(entry.highlightIdentity)}
              />
            ))
          ) : (
            <KnowledgeEmptyState
              title="No knowledge entries match"
              message="Try a broader search or reset the category filter."
              actionLabel="Clear filters"
              onAction={() => {
                setCategory("all")
                setQuery("")
              }}
              compact
            />
          )}
          {filteredEntries.length > pageSize ? (
            <div className="flex flex-col gap-3 border-t border-border pt-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span className="tabular-nums">Showing {pageStart}-{pageEnd} of {filteredEntries.length}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
                  Previous
                </Button>
                <Button size="sm" variant="outline" disabled={safePage >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function KnowledgeCategoryButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex min-h-10 w-auto shrink-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm font-medium outline-none transition-colors duration-ui focus-visible:ring-2 focus-visible:ring-ring lg:w-full ${
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <span>{label}</span>
      <span className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs text-muted-foreground">{count}</span>
    </button>
  )
}

function KnowledgeExplorerEntryCard({
  entry,
  compact,
  highlighted = false,
}: {
  entry: KnowledgeExplorerEntry
  compact?: boolean
  highlighted?: boolean
}) {
  const description = entry.description.trim()

  return (
    <article
      aria-label={highlighted ? `${entry.title}, updated review result` : undefined}
      className={`knowledge-entry rounded-lg border-2 p-4 transition-colors duration-ui motion-reduce:transition-none focus-within:ring-2 focus-within:ring-ring ${
        highlighted
          ? "border-primary bg-primary/5 ring-2 ring-primary/20"
          : "border-border bg-muted/60 hover:border-primary/40 hover:bg-muted"
      }`}
    >
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{entry.badge}</Badge>
            {highlighted ? <Badge className="gap-1"><Check className="size-3.5" aria-hidden="true" />Updated review result</Badge> : null}
            <span className="font-semibold text-foreground">{entry.title}</span>
          </div>
          {description ? (
            <div className={`mt-2 text-sm text-muted-foreground ${compact ? "line-clamp-2" : ""}`}>
              {description}
            </div>
          ) : null}
        </div>
        <div role="group" aria-label="Source work item IDs" className="flex max-w-[420px] flex-wrap gap-1">
          {entry.sourceWorkItemIds.slice(0, compact ? 6 : 10).map((id) => (
            <Badge key={id} variant="outline" className="font-mono text-xs tabular-nums">{id}</Badge>
          ))}
          {entry.sourceWorkItemIds.length > (compact ? 6 : 10) ? (
            <Badge
              variant="outline"
              className="font-mono text-xs tabular-nums text-muted-foreground"
              aria-label={`${entry.sourceWorkItemIds.length - (compact ? 6 : 10)} more source work items`}
              title={entry.sourceWorkItemIds.slice(compact ? 6 : 10).join(", ")}
            >
              +{entry.sourceWorkItemIds.length - (compact ? 6 : 10)}
            </Badge>
          ) : null}
        </div>
      </div>
      {entry.meta.length ? (
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
          {entry.meta.map((meta) => <Badge key={meta} variant="secondary">{meta}</Badge>)}
        </div>
      ) : null}
      <div className={`mt-3 rounded-md bg-card p-3 text-sm text-muted-foreground ${compact ? "line-clamp-2" : ""}`}>
        <span className="font-semibold text-foreground">Evidence:</span> {entry.evidence}
      </div>
    </article>
  )
}

function KnowledgeLoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  const rows = Array.from({ length: compact ? 2 : 4 }).map((_, index) => (
    <div key={index} className="rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-3">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
        </div>
        <Skeleton className="h-6 w-12" />
      </div>
    </div>
  ))

  return (
    <div role="status" aria-live="polite" aria-label={label} className="space-y-3">
      <span className="sr-only">{label}</span>
      {compact ? (
        <div className="space-y-3">{rows}</div>
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full lg:w-[420px]" />
          </div>
          <div className="grid gap-4 lg:grid-cols-[190px_1fr]">
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
            <div className="space-y-3">{rows}</div>
          </div>
        </>
      )}
    </div>
  )
}

function KnowledgeEmptyState({
  title,
  message,
  actionLabel,
  onAction,
  compact = false,
}: {
  title: string
  message: string
  actionLabel?: string
  onAction?: () => void
  compact?: boolean
}) {
  return (
    <DashboardEmptyPanel
      title={title}
      message={message}
      compact={compact}
      icon={SearchX}
      actionLabel={actionLabel}
      onAction={onAction}
      live={false}
    />
  )
}

function flattenKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase): KnowledgeExplorerEntry[] {
  return KNOWLEDGE_CATEGORIES.flatMap((category) => {
    const items = knowledgeBase[category.key] as AnyKnowledgeItem[]
    return items.map((item, index) => {
      const title = knowledgeTitle(category.key, item)
      const description = knowledgeDescription(category.key, item)
      const meta = knowledgeMeta(category.key, item)
      return {
        key: knowledgeItemKey(category.key, item, index),
        highlightIdentity: knowledgeHighlightIdentity(category.key, item),
        category: category.key,
        categoryLabel: category.label,
        badge: category.badge,
        title,
        description,
        evidence: item.evidence,
        sourceWorkItemIds: item.sourceWorkItemIds,
        meta,
        searchText: [
          category.label,
          title,
          description,
          item.evidence,
          item.sourceWorkItemIds.join(" "),
          meta.join(" "),
        ].join(" "),
      }
    })
  })
}

export function changedKnowledgeEntryIdentities(
  previous: ProjectKnowledgeBase,
  next: ProjectKnowledgeBase,
) {
  const previousCounts = new Map<string, number>()
  for (const category of KNOWLEDGE_CATEGORIES) {
    for (const item of previous[category.key] as AnyKnowledgeItem[]) {
      const identity = `${category.key}:${JSON.stringify(item)}`
      previousCounts.set(identity, (previousCounts.get(identity) ?? 0) + 1)
    }
  }

  const changed: string[] = []
  for (const category of KNOWLEDGE_CATEGORIES) {
    const items = next[category.key] as AnyKnowledgeItem[]
    items.forEach((item) => {
      const identity = `${category.key}:${JSON.stringify(item)}`
      const available = previousCounts.get(identity) ?? 0
      if (available > 0) {
        previousCounts.set(identity, available - 1)
      } else {
        changed.push(knowledgeHighlightIdentity(category.key, item))
      }
    })
  }
  return changed
}

function knowledgeHighlightIdentity(category: KnowledgeCategoryKey, item: AnyKnowledgeItem) {
  return `${category}:${JSON.stringify(item)}`
}

function knowledgeItemKey(category: KnowledgeCategoryKey, item: AnyKnowledgeItem, index: number) {
  const label = item.id ?? item.term ?? item.name ?? item.rule ?? item.workflowName ?? "item"
  const sources = item.sourceWorkItemIds.join("-")
  return `${category}-${label}-${sources}-${index}`
}

function knowledgeTitle(category: KnowledgeCategoryKey, item: AnyKnowledgeItem) {
  if (category === "businessRules") return item.rule ?? "Business rule"
  if (category === "stateTransitions") {
    const transition = [item.fromState, item.toState].filter(Boolean).join(" -> ")
    return transition ? `${item.workflowName ?? "Workflow"}: ${transition}` : item.workflowName ?? "Workflow"
  }
  if (category === "glossary") return item.term ?? "Glossary term"
  if (category === "crossDependencies") return `${item.sourceModule ?? "Source"} -> ${item.targetModule ?? "Target"}`
  return item.name ?? item.id ?? "Knowledge item"
}

function knowledgeDescription(category: KnowledgeCategoryKey, item: AnyKnowledgeItem) {
  if (category === "businessRules") return ""
  if (category === "glossary") return item.definition ?? "-"
  if (category === "stateTransitions") return item.triggerOrCondition ?? "-"
  return item.description ?? ""
}

function knowledgeMeta(category: KnowledgeCategoryKey, item: AnyKnowledgeItem) {
  return [
    item.moduleName,
    item.sourceField,
    category === "glossary" ? formatGlossaryType(item.type) : undefined,
    item.dependencyType,
    item.actor ? `Actor: ${item.actor}` : undefined,
  ].filter((value): value is string => Boolean(value))
}

function getKnowledgeCategoryCounts(knowledgeBase: ProjectKnowledgeBase) {
  return {
    modules: knowledgeBase.modules.length,
    businessRules: knowledgeBase.businessRules.length,
    stateTransitions: knowledgeBase.stateTransitions.length,
    glossary: knowledgeBase.glossary.length,
    crossDependencies: knowledgeBase.crossDependencies.length,
  } satisfies Record<KnowledgeCategoryKey, number>
}

function countKnowledgeItems(knowledgeBase: ProjectKnowledgeBase) {
  return Object.values(getKnowledgeCategoryCounts(knowledgeBase)).reduce((sum, count) => sum + count, 0)
}

function combineKnowledgeBasesForPreview(knowledgeBases: ProjectKnowledgeBase[]): ProjectKnowledgeBase {
  return {
    modules: knowledgeBases.flatMap((base) => base.modules),
    businessRules: knowledgeBases.flatMap((base) => base.businessRules),
    stateTransitions: knowledgeBases.flatMap((base) => base.stateTransitions),
    glossary: knowledgeBases.flatMap((base) => base.glossary),
    crossDependencies: knowledgeBases.flatMap((base) => base.crossDependencies),
  }
}

function filterKnowledgeBaseBySource(knowledgeBase: ProjectKnowledgeBase, sourceIds: Set<string>): ProjectKnowledgeBase {
  const keep = <TItem extends KnowledgeSource>(items: TItem[]) =>
    items.filter((item) => item.sourceWorkItemIds.some((id) => sourceIds.has(id.trim())))
  return {
    modules: keep(knowledgeBase.modules),
    businessRules: keep(knowledgeBase.businessRules),
    stateTransitions: keep(knowledgeBase.stateTransitions),
    glossary: keep(knowledgeBase.glossary),
    crossDependencies: keep(knowledgeBase.crossDependencies),
  }
}

function syncStatusToneClass(status?: string | null) {
  const value = (status ?? "active").toLowerCase()
  if (value === "active") return "border-success/40 bg-success/10 text-success"
  if (value === "stale" || value === "pending") return "border-warning/40 bg-warning/10 text-warning-foreground dark:text-warning"
  if (value === "error" || value === "failed") return "border-destructive/40 bg-destructive/10 text-destructive"
  return ""
}

function formatGlossaryType(value?: string) {
  return (value ?? "term").replace(/_/g, " ")
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function normalizeSearch(value: string) {
  return value.trim().toLowerCase()
}
