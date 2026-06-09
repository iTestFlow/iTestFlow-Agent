"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import {
  AlertTriangle,
  ArrowUpDown,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Copy,
  Database,
  Download,
  History,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContextFilterSelector } from "@/components/domain/context-filter-selector"
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle"
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress"
import { useAiGeneration } from "@/components/workflow/use-ai-generation"
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  DEFAULT_CONTEXT_STATES,
  DEFAULT_CONTEXT_WORK_ITEM_TYPES,
} from "@/lib/project-context-defaults"
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project"
import {
  projectScopeKey,
  selectAvailableDefaults,
  useProjectWorkItemMetadata,
} from "@/shared/lib/use-project-work-item-metadata"

const COPY_FEEDBACK_MS = 3000

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
}

type KnowledgeGeneratedDraft = {
  promptVersion: string
  provider: string
  model: string
  requestedMode: KnowledgeCompileMode
  mode: KnowledgeCompileMode
  fallbackReason?: string
  sourceWorkItemCount: number
  promptedSourceWorkItemCount: number
  changedSourceWorkItemCount: number
  retiredSourceWorkItemCount: number
  rawOutput: string
  knowledgeBase: ProjectKnowledgeBase
  generatedAt: string
  alreadyCurrent?: boolean
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
  createdAt: string
  updatedAt: string
}

type KnowledgeLintResult = {
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
}

type KnowledgeManualDraft = {
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
}

type BuildMode = "auto" | "manual"
type BuildStep = "index" | "prepare" | "preview"
type TopTab = "hub" | "build"

const KNOWLEDGE_CATEGORIES = [
  { key: "modules", label: "Modules", badge: "Module" },
  { key: "businessRules", label: "Business Rules", badge: "Business Rule" },
  { key: "stateTransitions", label: "State Transitions", badge: "State Transition" },
  { key: "glossary", label: "Glossary", badge: "Glossary" },
  { key: "crossDependencies", label: "Dependencies", badge: "Dependency" },
] as const

type KnowledgeCategoryKey = (typeof KNOWLEDGE_CATEGORIES)[number]["key"]
type KnowledgeExplorerCategory = KnowledgeCategoryKey | "all"

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

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  })
  const text = await response.text()
  const json = parseJsonResponse(text, response.ok)
  if (!response.ok) throw new Error(json.error ?? `Request failed: ${response.status}`)
  return json as T
}

function parseJsonResponse(text: string, ok: boolean) {
  try {
    return JSON.parse(text)
  } catch {
    if (ok) throw new Error("The server returned an invalid JSON response.")
    return { error: "The server returned a non-JSON response. Check the server logs or runtime configuration." }
  }
}

export function ProjectContextClient() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null)
  const [activeTab, setActiveTab] = useState<TopTab>("hub")
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
  const [generatedDraft, setGeneratedDraft] = useState<KnowledgeGeneratedDraft | null>(null)
  const [generatedSaveLoading, setGeneratedSaveLoading] = useState(false)
  const [manualKnowledgeDraft, setManualKnowledgeDraft] = useState<KnowledgeManualDraft | null>(null)
  const [manualKnowledgeCurrentBatch, setManualKnowledgeCurrentBatch] = useState(1)
  const [manualKnowledgeBatchResponses, setManualKnowledgeBatchResponses] = useState<Record<number, string>>({})
  const [manualKnowledgeValidatedBatches, setManualKnowledgeValidatedBatches] = useState<Record<number, ProjectKnowledgeBase>>({})
  const [manualKnowledgeValidationLoading, setManualKnowledgeValidationLoading] = useState(false)
  const [manualKnowledgeSaveLoading, setManualKnowledgeSaveLoading] = useState(false)
  const [promptCopied, setPromptCopied] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalPages, setTotalPages] = useState(1)
  const gen = useAiGeneration()
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
  const filterProjectKey = projectScopeKey(scope)
  const {
    metadata: workItemMetadata,
    loading: workItemMetadataLoading,
    error: workItemMetadataError,
    retry: retryWorkItemMetadata,
  } = useProjectWorkItemMetadata(scope)

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
      setScope(custom.detail ?? readActiveProject())
      setHasUnfinishedWork(false)
    }
    window.addEventListener("itestflow:active-project-changed", onChange)
    return () => window.removeEventListener("itestflow:active-project-changed", onChange)
  }, [])

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
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    setPromptCopied(false)
    setKnowledgeError(null)
    setKnowledgeLint(null)
    setKnowledgeLog([])
    setKnowledgeLogVisible(false)
    setKnowledgeExport(null)
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
    if (!scope) return
    const timeoutId = window.setTimeout(() => {
      setPage(1)
      void loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch })
    }, 300)

    return () => window.clearTimeout(timeoutId)
  }, [contextSearch, loadStatus, scope, sortBy, sortDirection])

  useEffect(() => {
    if (!promptCopied) return
    const timeoutId = window.setTimeout(() => setPromptCopied(false), COPY_FEEDBACK_MS)
    return () => window.clearTimeout(timeoutId)
  }, [promptCopied])

  useEffect(() => {
    setPromptCopied(false)
  }, [manualKnowledgeCurrentBatch])

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
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    setPromptCopied(false)
  }

  function resetBuildState() {
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

    setHasUnfinishedWork(true)
    setBuildError(null)
    setGeneratedDraft(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeValidatedBatches({})
    const draft = await gen.start((signal) =>
      postJson<KnowledgeGeneratedDraft>("/api/context/knowledge/preview", { scope, mode: compileMode }, signal),
    )
    if (!draft) return // cancelled or failed: the progress panel owns the message
    setGeneratedDraft(draft)
    if (draft.alreadyCurrent) setHasUnfinishedWork(false)
    setBuildStep(draft.alreadyCurrent ? "prepare" : "preview")
    scrollBuildSection(draft.alreadyCurrent ? autoPrepareStepRef : autoPreviewStepRef)
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
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    try {
      const data = await postJson<KnowledgeManualDraft>("/api/context/knowledge/manual/draft", { scope, mode: compileMode })
      setManualKnowledgeDraft(data)
      const nextStep = data.batchCount === 0 && data.retiredSourceWorkItemCount > 0 ? "preview" : "prepare"
      setBuildStep(nextStep)
      scrollBuildSection(nextStep === "preview" ? manualPreviewStepRef : manualPrepareStepRef)
    } catch (prepareError) {
      setBuildError(prepareError instanceof Error ? prepareError.message : "External LLM knowledge prompt preparation failed.")
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
        mode: manualKnowledgeDraft.mode,
        save: false,
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
      const snapshot = await postJson<ProjectKnowledgeSnapshot>("/api/context/knowledge/save", {
        scope,
        provider: generatedDraft.provider,
        model: generatedDraft.model,
        rawOutput: generatedDraft.rawOutput,
        requestedMode: generatedDraft.requestedMode,
        mode: generatedDraft.mode,
        knowledgeBase: generatedDraft.knowledgeBase,
      })
      setKnowledgeSnapshot(snapshot)
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
      const data = await postJson<KnowledgeManualValidationResult>("/api/context/knowledge/manual/finalize", {
        scope,
        mode: manualKnowledgeDraft.mode,
        partialKnowledgeBases,
      })
      if (data.snapshot) setKnowledgeSnapshot(data.snapshot)
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

  async function runKnowledgeHealthCheck() {
    if (!scope) return
    setKnowledgeHealthLoading(true)
    setKnowledgeError(null)
    try {
      const data = await postJson<KnowledgeLintResult>("/api/context/knowledge/lint", { scope })
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
  const rangeEnd = Math.min(totalCount, rangeStart + recentItems.length - 1)
  const totalKnowledgeItems = knowledgeSnapshot ? countKnowledgeItems(knowledgeSnapshot.knowledgeBase) : 0
  const canLoadIndex = Boolean(scope)
    && Boolean(workItemMetadata)
    && !workItemMetadataLoading
    && !workItemMetadataError
    && workItemTypes.length > 0
    && states.length > 0
    && !buildLoading
  const canPrepareKnowledge = Boolean(scope) && Boolean(result) && !buildLoading

  return (
    <div className="space-y-4">
      {!scope ? (
        <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/15 p-3 text-sm text-warning-foreground dark:text-warning">
          <AlertTriangle className="size-4" />
          Select an Azure DevOps project before building project knowledge.
        </div>
      ) : null}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TopTab)} className="flex-col gap-4">
        <TabsList variant="primary" className="grid h-auto w-full grid-cols-2 sm:inline-grid sm:w-fit sm:min-w-[460px]">
          <TabsTrigger
            value="hub"
            className="h-10 px-3 py-2 duration-200"
          >
            Knowledge Hub
          </TabsTrigger>
          <TabsTrigger
            value="build"
            className="h-10 px-3 py-2 duration-200"
          >
            Build Knowledge
          </TabsTrigger>
        </TabsList>

        <TabsContent value="hub" className="space-y-4">
          <HubSummary
            activeSourceCount={totalCount}
            totalKnowledgeItems={totalKnowledgeItems}
            snapshot={knowledgeSnapshot}
            loading={knowledgeStatusLoading}
          />

          <KnowledgeOpsPanel
            lint={knowledgeLint}
            logItems={knowledgeLog}
            logVisible={knowledgeLogVisible}
            exportResult={knowledgeExport}
            healthLoading={knowledgeHealthLoading}
            logLoading={knowledgeLogLoading}
            exportLoading={knowledgeExportLoading}
            onRunHealthCheck={runKnowledgeHealthCheck}
            onToggleLog={toggleKnowledgeLog}
            onExport={exportKnowledgeWiki}
          />

          {knowledgeError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {knowledgeError}
            </div>
          ) : null}

          <Card className="qa-card">
            <CardHeader>
              <CardTitle className="text-base">Knowledge Explorer</CardTitle>
            </CardHeader>
            <CardContent>
              {knowledgeStatusLoading ? (
                <div className="text-sm text-muted-foreground">Loading saved knowledge base...</div>
              ) : knowledgeSnapshot ? (
                <KnowledgeExplorer knowledgeBase={knowledgeSnapshot.knowledgeBase} />
              ) : (
                <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
                  No knowledge base has been saved yet. Use Build Knowledge to compile source-backed project knowledge.
                </div>
              )}
            </CardContent>
          </Card>

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
            emptyMessage="No project context has been indexed yet. Use Build Knowledge to prepare context from Azure DevOps work items."
            onSearchChange={setContextSearch}
            onSortChange={changeSort}
            onPageChange={changePage}
          />
        </TabsContent>

        <TabsContent value="build" className="space-y-4">
          <Card className="qa-card">
            <CardHeader>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base">Build Knowledge</CardTitle>
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
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    {buildError}
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

                      {gen.status !== "idle" && gen.status !== "completed" ? (
                        <AiGenerationProgress
                          variant="generic"
                          title="Building project knowledge"
                          status={gen.status}
                          elapsedSeconds={gen.elapsedSeconds}
                          errorMessage={gen.errorMessage}
                          canCancel
                          onCancel={gen.cancel}
                          onRetry={() => {
                            gen.retry()
                            void prepareAutoKnowledge()
                          }}
                        />
                      ) : null}

                      {generatedDraft?.alreadyCurrent ? (
                        <GeneratedPreviewPanel
                          draft={generatedDraft}
                          saving={generatedSaveLoading}
                          onSave={saveGeneratedKnowledge}
                        />
                      ) : null}
                    </div>
                  ) : null}

                  {generatedDraft && !generatedDraft.alreadyCurrent ? (
                    <div ref={autoPreviewStepRef} className="scroll-mt-4">
                      <GeneratedPreviewPanel
                        draft={generatedDraft}
                        saving={generatedSaveLoading}
                        onSave={saveGeneratedKnowledge}
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
                          copied={promptCopied}
                          validatedBatches={manualKnowledgeValidatedBatches}
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
                          onCopy={(prompt) => {
                            void navigator.clipboard.writeText(prompt)
                            setPromptCopied(true)
                          }}
                          onValidate={validateManualKnowledgeBatch}
                          onSave={saveManualKnowledgeBatches}
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
                        copied={promptCopied}
                        validatedBatches={manualKnowledgeValidatedBatches}
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
                        onCopy={(prompt) => {
                          void navigator.clipboard.writeText(prompt)
                          setPromptCopied(true)
                        }}
                        onValidate={validateManualKnowledgeBatch}
                        onSave={saveManualKnowledgeBatches}
                      />
                    </div>
                  ) : null}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </TabsContent>
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
    <Card className="qa-card">
      <CardContent className="space-y-3 p-4">
        <div className="grid gap-3 md:grid-cols-2">
          <MetricPanel label="Active source work items" value={activeSourceCount} />
          <MetricPanel label="Knowledge base items" value={loading ? "-" : totalKnowledgeItems} />
        </div>
        <div className="text-sm text-muted-foreground">
          <div><span className="font-semibold text-foreground">Last extracted:</span> {formatDate(snapshot?.extractedAt)}</div>
        </div>
      </CardContent>
    </Card>
  )
}

function MetricPanel({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold text-foreground">{value}</div>
    </div>
  )
}

function BuildStepper({ step }: { step: BuildStep }) {
  const steps = [
    { key: "index", label: "Load Project Index" },
    { key: "prepare", label: "Prepare Knowledge Preview" },
    { key: "preview", label: "Preview & Save" },
  ] as const
  const activeIndex = steps.findIndex((item) => item.key === step)

  return (
    <div className="grid gap-2 rounded-md border border-border bg-muted p-3 lg:grid-cols-3">
      {steps.map((item, index) => {
        const done = index < activeIndex
        const active = item.key === step
        return (
          <div
            key={item.key}
            className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              active
                ? "border-primary bg-accent text-primary"
                : done
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-border bg-card text-muted-foreground"
            }`}
          >
            {done ? <CheckCircle2 className="size-4" /> : <span className="font-mono text-xs">{index + 1}</span>}
            <span className="font-semibold">{item.label}</span>
          </div>
        )
      })}
    </div>
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
          <Button className="h-11 w-full justify-center" onClick={onLoad} disabled={!canLoad}>
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
              className={`rounded-md border px-3 py-2 text-sm font-semibold transition-all duration-200 ${
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
              className={`rounded-md border px-3 py-2 text-sm font-semibold transition-all duration-200 ${
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
          <Button className="h-11 w-full justify-center" onClick={onPrepare} disabled={!canPrepare}>
            {loading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

function GeneratedPreviewPanel({
  draft,
  saving,
  onSave,
}: {
  draft: KnowledgeGeneratedDraft
  saving: boolean
  onSave: () => void
}) {
  const totalItems = countKnowledgeItems(draft.knowledgeBase)

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

  return (
    <div className="space-y-4 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Generated Knowledge Preview</div>
          <div className="text-xs text-muted-foreground">
            {totalItems} entries from {draft.sourceWorkItemCount} active source work items.
            {draft.mode === "incremental"
              ? ` ${draft.changedSourceWorkItemCount} changed, ${draft.retiredSourceWorkItemCount} retired.`
              : null}
          </div>
        </div>
        <Badge variant="outline">Prompt {draft.promptVersion}</Badge>
      </div>
      {draft.fallbackReason ? (
        <div className="rounded-md border border-warning/40 bg-warning/15 p-3 text-xs text-warning-foreground dark:text-warning">
          {draft.fallbackReason}
        </div>
      ) : null}
      <KnowledgeExplorer knowledgeBase={draft.knowledgeBase} compact />
      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button onClick={onSave} disabled={saving}>
          {saving ? <RefreshCw className="size-4 animate-spin" /> : <Save className="size-4" />}
          {saving ? "Saving..." : "Save Knowledge Base"}
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
  copied,
  validatedBatches,
  batchRef,
  showPrompt = true,
  showPreview = true,
  onResponseChange,
  onCopy,
  onValidate,
  onSave,
}: {
  draft: KnowledgeManualDraft
  currentBatch?: KnowledgeManualBatchPrompt
  responses: Record<number, string>
  validatedCount: number
  allValidated: boolean
  validationLoading: boolean
  saveLoading: boolean
  copied: boolean
  validatedBatches: Record<number, ProjectKnowledgeBase>
  batchRef: RefObject<HTMLDivElement | null>
  showPrompt?: boolean
  showPreview?: boolean
  onResponseChange: (batchIndex: number, value: string) => void
  onCopy: (prompt: string) => void
  onValidate: () => void
  onSave: () => void
}) {
  const hasRetiredOnlyUpdate = draft.batchCount === 0 && draft.retiredSourceWorkItemCount > 0
  const previewKnowledgeBase = useMemo(() => {
    const bases = Object.values(validatedBatches)
    if (bases.length === 1) return bases[0]
    if (!bases.length) return null
    return combineKnowledgeBasesForPreview(bases)
  }, [validatedBatches])

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
            <Button variant="outline" onClick={() => onCopy(currentBatch.prompt)} disabled={copied}>
              <Copy className="size-4" />
              {copied ? "Copied" : "Copy Prompt"}
            </Button>
          </div>
          <Textarea value={currentBatch.prompt} readOnly className="min-h-[320px] font-mono text-xs" />
          <div className="space-y-2">
            <Label className="text-sm font-semibold text-foreground">External LLM Response</Label>
            <Textarea
              value={responses[currentBatch.batchIndex] ?? ""}
              onChange={(event) => onResponseChange(currentBatch.batchIndex, event.target.value)}
              className="min-h-[220px] font-mono text-xs"
              placeholder="Paste the JSON response for this batch."
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={onValidate}
              disabled={!responses[currentBatch.batchIndex]?.trim() || validationLoading}
            >
              {validationLoading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
              {validationLoading ? "Validating..." : "Validate Batch"}
            </Button>
          </div>
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
          <KnowledgeExplorer knowledgeBase={previewKnowledgeBase} compact />
          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button onClick={onSave} disabled={saveLoading}>
              {saveLoading ? <RefreshCw className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saveLoading ? "Saving..." : "Save Knowledge Base"}
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
    <Button variant="ghost" size="sm" className="-ml-3 h-8 px-2 text-foreground" onClick={onClick}>
      {label}
      <ArrowUpDown className="size-3.5" />
      {active ? <span className="text-xs text-muted-foreground">{direction === "asc" ? "Asc" : "Desc"}</span> : null}
    </Button>
  )
}

function IndexedContextPanel({
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
}: {
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
}) {
  const safeTotalPages = Math.max(1, totalPages)
  const safePage = Math.min(Math.max(1, page), safeTotalPages)
  const canGoPrevious = safePage > 1
  const canGoNext = safePage < safeTotalPages

  return (
    <Card className="qa-card">
      <CardHeader>
        <CardTitle className="text-base">Indexed Project Context</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="text-sm text-muted-foreground">
            Showing {rangeStart}-{rangeEnd} of {totalCount} active source work items available for retrieval.
          </div>
          <div className="relative w-full lg:w-[360px]">
            <Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="pl-8"
              placeholder="Search ID, title, or indexed text"
            />
          </div>
        </div>

        {!items.length && loading ? (
          <div className="text-sm text-muted-foreground">Loading indexed context...</div>
        ) : items.length ? (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <Table className={loading ? "opacity-60" : undefined}>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>
                      <SortHeader label="Type" active={sortBy === "type"} direction={sortDirection} onClick={() => onSortChange("type")} />
                    </TableHead>
                    <TableHead className="min-w-[320px]">Title</TableHead>
                    <TableHead>Chunks</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>
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
                      <TableCell className="font-mono text-xs font-semibold text-primary">{item.workItemId}</TableCell>
                      <TableCell><Badge variant="secondary">{item.workItemType}</Badge></TableCell>
                      <TableCell className="font-medium text-foreground">{item.title}</TableCell>
                      <TableCell>{item.chunkCount}</TableCell>
                      <TableCell><Badge variant="outline">{item.syncStatus ?? "active"}</Badge></TableCell>
                      <TableCell>{formatDate(item.lastIndexedAt)}</TableCell>
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
          <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
            {search.trim() ? "No indexed work items match the current search." : emptyMessage}
          </div>
        )}
      </CardContent>
    </Card>
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
        <CardTitle className="text-base">Latest Indexing Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-md border border-border bg-card p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 text-lg font-semibold text-foreground">{value}</div>
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

function KnowledgeOpsPanel({
  lint,
  logItems,
  logVisible,
  exportResult,
  healthLoading,
  logLoading,
  exportLoading,
  onRunHealthCheck,
  onToggleLog,
  onExport,
}: {
  lint: KnowledgeLintResult | null
  logItems: KnowledgeLogItem[]
  logVisible: boolean
  exportResult: KnowledgeExportResult | null
  healthLoading: boolean
  logLoading: boolean
  exportLoading: boolean
  onRunHealthCheck: () => void
  onToggleLog: () => void
  onExport: () => void
}) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-card p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Compiled Knowledge Operations</div>
          <div className="text-xs text-muted-foreground">Health checks, event history, and Markdown export for the source-backed knowledge layer.</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onRunHealthCheck} disabled={healthLoading}>
            {healthLoading ? <RefreshCw className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
            Health
          </Button>
          <Button variant={logVisible ? "secondary" : "outline"} size="sm" onClick={onToggleLog} disabled={logLoading}>
            {logLoading ? <RefreshCw className="size-4 animate-spin" /> : <History className="size-4" />}
            {logVisible ? "Hide Log" : "Log"}
          </Button>
          <Button variant="outline" size="sm" onClick={onExport} disabled={exportLoading}>
            {exportLoading ? <RefreshCw className="size-4 animate-spin" /> : <Download className="size-4" />}
            Export
          </Button>
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
                <span className="font-semibold text-foreground">{issue.title}</span>
              </div>
              <div className="mt-1 text-muted-foreground">{issue.message}</div>
            </div>
          ))}
        </div>
      ) : lint ? (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
          Knowledge health check passed without open issues.
        </div>
      ) : null}

      {exportResult ? (
        <div className="rounded-md border border-primary/40 bg-accent p-3 text-sm text-primary">
          Exported {exportResult.fileCount} Markdown files to <span className="font-mono">{exportResult.exportRoot}</span>.
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
    </div>
  )
}

function KnowledgeMetric({ label, value, tone }: { label: string; value: number; tone?: "error" | "warning" }) {
  const valueClass = tone === "error" ? "text-destructive" : tone === "warning" ? "text-warning-foreground dark:text-warning" : "text-foreground"
  return (
    <div className="rounded-md border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${valueClass}`}>{value}</div>
    </div>
  )
}

function KnowledgeExplorer({ knowledgeBase, compact = false }: { knowledgeBase: ProjectKnowledgeBase; compact?: boolean }) {
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

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-sm text-muted-foreground">
          {filteredEntries.length} entries match the current filters.
        </div>
        <div className="w-full lg:w-[420px]">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search knowledge or source IDs" />
        </div>
      </div>
      <div className={`grid gap-4 ${compact ? "lg:grid-cols-[180px_1fr]" : "lg:grid-cols-[190px_1fr]"}`}>
        <div className="space-y-1">
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
        <div className={`space-y-3 ${compact ? "max-h-[520px] overflow-y-auto pr-1" : ""}`}>
          {visibleEntries.length ? (
            visibleEntries.map((entry) => <KnowledgeExplorerEntryCard key={entry.key} entry={entry} compact={compact} />)
          ) : (
            <div className="rounded-md border border-border bg-card p-5 text-sm text-muted-foreground">
              No knowledge entries match the current filters.
            </div>
          )}
          {filteredEntries.length > pageSize ? (
            <div className="flex items-center justify-between border-t border-border pt-3 text-sm text-muted-foreground">
              <span>Showing {pageStart}-{pageEnd} of {filteredEntries.length}</span>
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
      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm font-medium ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      <span>{label}</span>
      <span className="rounded-sm border border-border bg-card px-1.5 py-0.5 text-xs text-muted-foreground">{count}</span>
    </button>
  )
}

function KnowledgeExplorerEntryCard({ entry, compact }: { entry: KnowledgeExplorerEntry; compact?: boolean }) {
  return (
    <div className="rounded-md border border-border bg-muted p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{entry.badge}</Badge>
            <span className="font-semibold text-foreground">{entry.title}</span>
          </div>
          <div className={`mt-2 text-sm text-muted-foreground ${compact ? "line-clamp-2" : ""}`}>
            {entry.description}
          </div>
        </div>
        <div className="flex max-w-[420px] flex-wrap gap-1">
          {entry.sourceWorkItemIds.slice(0, compact ? 6 : 10).map((id) => (
            <Badge key={id} variant="outline" className="font-mono text-xs">{id}</Badge>
          ))}
          {entry.sourceWorkItemIds.length > (compact ? 6 : 10) ? (
            <Badge variant="outline" className="font-mono text-xs">+{entry.sourceWorkItemIds.length - (compact ? 6 : 10)}</Badge>
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
    </div>
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
  if (category === "glossary") return item.definition ?? "-"
  if (category === "stateTransitions") return item.triggerOrCondition ?? "-"
  return item.description ?? "-"
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
