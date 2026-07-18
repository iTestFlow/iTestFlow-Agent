"use client"

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import { DashboardEmptyPanel } from "@/components/dashboard/dashboard-states"
import {
  AlertTriangle,
  ArrowUpDown,
  BookOpen,
  Check,
  Clock3,
  Database,
  Download,
  History,
  MessageSquareWarning,
  RefreshCw,
  Search,
  SearchX,
  Send,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react"

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContextFilterSelector } from "@/components/domain/context-filter-selector"
import { patchJson, postJson } from "@/components/workflow/post-json"
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
import type { ProjectKnowledgeEvidenceRef } from "@/modules/rag/project-knowledge.schema"
import { KnowledgeBuildV4, type KnowledgeInReviewDraft } from "./knowledge-build-v4"
import {
  KnowledgeCategoryFilterButton,
  KnowledgeEntryCard,
  type KnowledgeCategoryVisualKey,
  type KnowledgeDisplayEntry,
} from "./knowledge-entry-card"
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

export function appendUniqueContextItems(current: RecentContextItem[], incoming: RecentContextItem[]) {
  const itemsById = new Map(current.map((item) => [item.workItemId, item]))
  for (const item of incoming) itemsById.set(item.workItemId, item)
  return Array.from(itemsById.values())
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

type KnowledgeStatusResult = {
  snapshot: ProjectKnowledgeSnapshot | null
  generationAvailable?: boolean
  latestInReviewDraft?: KnowledgeInReviewDraft | null
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

type TopTab = "hub" | "build"
type WorkspaceRole = "owner" | "admin" | "member"
type HubView = "explorer" | "context" | "candidates"
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

const KNOWLEDGE_CATEGORIES = [
  { key: "modules", label: "Modules", badge: "Module", iconKey: "module" },
  { key: "businessRules", label: "Business Rules", badge: "Business Rule", iconKey: "businessRule" },
  { key: "stateTransitions", label: "State Transitions", badge: "State Transition", iconKey: "stateTransition" },
  { key: "glossary", label: "Glossary", badge: "Glossary", iconKey: "glossary" },
  { key: "crossDependencies", label: "Dependencies", badge: "Dependency", iconKey: "dependency" },
] as const satisfies ReadonlyArray<{
  key: string
  label: string
  badge: string
  iconKey: KnowledgeCategoryVisualKey
}>

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

type KnowledgeExplorerEntry = KnowledgeDisplayEntry<KnowledgeCategoryKey>

export function KnowledgeHubClient({ workspaceRole }: { workspaceRole: WorkspaceRole | null }) {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null)
  const [activeTab, setActiveTab] = useState<TopTab>("hub")
  const [hubView, setHubView] = useState<HubView>("explorer")
  const [workItemTypes, setWorkItemTypes] = useState<string[]>(DEFAULT_CONTEXT_WORK_ITEM_TYPES)
  const [states, setStates] = useState<string[]>(DEFAULT_CONTEXT_STATES)
  const [buildLoading, setBuildLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [contextLoadingMore, setContextLoadingMore] = useState(false)
  const [contextStatusError, setContextStatusError] = useState<string | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [result, setResult] = useState<IndexResult | null>(null)
  const [recentItems, setRecentItems] = useState<RecentContextItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [contextSearch, setContextSearch] = useState("")
  const [knowledgeStatusLoading, setKnowledgeStatusLoading] = useState(false)
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null)
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState<ProjectKnowledgeSnapshot | null>(null)
  const [generationAvailable, setGenerationAvailable] = useState<boolean | null>(null)
  const [resumableDraft, setResumableDraft] = useState<KnowledgeInReviewDraft | null>(null)
  const [knowledgeLint, setKnowledgeLint] = useState<KnowledgeLintResult | null>(null)
  const [knowledgeLog, setKnowledgeLog] = useState<KnowledgeLogItem[]>([])
  const [knowledgeLogVisible, setKnowledgeLogVisible] = useState(false)
  const [knowledgeExport, setKnowledgeExport] = useState<KnowledgeExportResult | null>(null)
  const [knowledgeHealthLoading, setKnowledgeHealthLoading] = useState(false)
  const [knowledgeLogLoading, setKnowledgeLogLoading] = useState(false)
  const [knowledgeExportLoading, setKnowledgeExportLoading] = useState(false)
  const [knowledgeReportLoading, setKnowledgeReportLoading] = useState(false)
  const [knowledgeCandidates, setKnowledgeCandidates] = useState<KnowledgeCandidate[]>([])
  const [candidateStatus, setCandidateStatus] = useState<KnowledgeCandidateStatus | "all">("all")
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalPages, setTotalPages] = useState(1)
  const [sortBy, setSortBy] = useState<ContextSortBy>("lastIndexedAt")
  const [sortDirection, setSortDirection] = useState<ContextSortDirection>("desc")
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false)
  useUnsavedChangesGuard({
    dirty: hasUnfinishedWork,
    busy: buildLoading,
  })
  const initializedFilterProjectRef = useRef<string | null>(null)
  const contextRequestIdRef = useRef(0)
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
      setGenerationAvailable(typeof data.generationAvailable === "boolean" ? data.generationAvailable : null)
      setResumableDraft(data.latestInReviewDraft ?? null)
    } catch {
      setKnowledgeSnapshot(null)
      setGenerationAvailable(null)
      setResumableDraft(null)
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

  const loadStatus = useCallback(async (
    activeScope: ActiveProjectScope | null,
    options?: {
      page?: number
      sortBy?: ContextSortBy
      sortDirection?: ContextSortDirection
      query?: string
      append?: boolean
    },
  ) => {
    if (!activeScope) return
    const nextPage = options?.page ?? 1
    const nextSortBy = options?.sortBy ?? "lastIndexedAt"
    const nextSortDirection = options?.sortDirection ?? "desc"
    const nextQuery = options?.query ?? ""
    const append = options?.append ?? false
    const requestId = ++contextRequestIdRef.current

    setContextStatusError(null)
    if (append) {
      setContextLoadingMore(true)
    } else {
      setContextLoadingMore(false)
      setStatusLoading(true)
    }
    try {
      const data = await postJson<ContextStatusResult>("/api/context/status", {
        scope: activeScope,
        page: nextPage,
        pageSize,
        sortBy: nextSortBy,
        sortDirection: nextSortDirection,
        query: nextQuery,
      })
      if (requestId !== contextRequestIdRef.current) return
      setRecentItems((current) => append ? appendUniqueContextItems(current, data.items) : data.items)
      setTotalCount(data.totalCount)
      setTotalPages(data.totalPages)
      setPage(data.page)
      setSortBy(data.sortBy)
      setSortDirection(data.sortDirection)
    } catch (error) {
      if (requestId !== contextRequestIdRef.current) return
      if (!append) {
        setRecentItems([])
        setTotalCount(0)
        setTotalPages(1)
      }
      setContextStatusError(error instanceof Error ? error.message : "Indexed project context could not be loaded.")
    } finally {
      if (requestId === contextRequestIdRef.current) {
        if (append) setContextLoadingMore(false)
        else setStatusLoading(false)
      }
    }
  }, [pageSize])

  useEffect(() => {
    setScope(readActiveProject())
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>
      contextRequestIdRef.current += 1
      setScope(custom.detail ?? readActiveProject())
      setHasUnfinishedWork(false)
    }
    window.addEventListener("itestflow:active-project-changed", onChange)
    return () => window.removeEventListener("itestflow:active-project-changed", onChange)
  }, [])

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
    if (!scope) {
      contextRequestIdRef.current += 1
      setRecentItems([])
      setTotalCount(0)
      setTotalPages(1)
      setPage(1)
      setStatusLoading(false)
      setContextLoadingMore(false)
      setContextStatusError(null)
      return
    }
    let cancelled = false

    setBuildError(null)
    setResult(null)
    setKnowledgeError(null)
    setKnowledgeLint(null)
    setKnowledgeLog([])
    setKnowledgeLogVisible(false)
    setKnowledgeExport(null)
    setKnowledgeReportLoading(false)
    setKnowledgeCandidates([])
    setCandidateStatus("all")
    setPage(1)
    setSortBy("lastIndexedAt")
    setSortDirection("desc")
    setContextSearch("")
    setContextLoadingMore(false)
    setContextStatusError(null)
    setKnowledgeStatusLoading(true)

    void loadStatus(scope, {
      page: 1,
      sortBy: "lastIndexedAt",
      sortDirection: "desc",
      query: "",
    })

    void postJson<KnowledgeStatusResult>("/api/context/knowledge/status", { scope })
      .then((data) => {
        if (cancelled) return
        setKnowledgeSnapshot(data.snapshot)
        setGenerationAvailable(typeof data.generationAvailable === "boolean" ? data.generationAvailable : null)
        setResumableDraft(data.latestInReviewDraft ?? null)
      })
      .catch(() => {
        if (cancelled) return
        setKnowledgeSnapshot(null)
        setGenerationAvailable(null)
        setResumableDraft(null)
      })
      .finally(() => {
        if (!cancelled) setKnowledgeStatusLoading(false)
      })

    void refreshKnowledgeLog(scope)

    return () => {
      cancelled = true
    }
  }, [loadStatus, refreshKnowledgeLog, scope])

  useEffect(() => {
    if (scope) void refreshKnowledgeCandidates(scope, candidateStatus)
  }, [candidateStatus, refreshKnowledgeCandidates, scope])

  useEffect(() => {
    if (!scope) return
    const timeoutId = window.setTimeout(() => {
      setPage(1)
      void loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch })
    }, 300)

    return () => window.clearTimeout(timeoutId)
  }, [contextSearch, loadStatus, scope, sortBy, sortDirection])

  function invalidateBuildIndex() {
    setBuildError(null)
    setResult(null)
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
    try {
      await indexContextForBuild()
    } catch (indexError) {
      setBuildError(indexError instanceof Error ? indexError.message : "Project index loading failed.")
    } finally {
      setBuildLoading(false)
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
    if (!scope) return false
    setKnowledgeReportLoading(true)
    setKnowledgeError(null)
    try {
      await postJson("/api/context/knowledge/lint/report", { scope, ...input })
      setKnowledgeLint(await postJson<KnowledgeLintResult>("/api/context/knowledge/lint", { scope, run: false }))
      await refreshKnowledgeLog(scope)
      return true
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The lint miss could not be reported.")
      return false
    } finally {
      setKnowledgeReportLoading(false)
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
    } catch (error) {
      setKnowledgeError(error instanceof Error ? error.message : "The candidate could not be updated.")
    } finally {
      setCandidateLoading(false)
    }
  }

  function changeSort(nextSortBy: ContextSortBy) {
    const nextDirection = sortBy === nextSortBy && sortDirection === "asc" ? "desc" : "asc"
    setStatusLoading(true)
    setSortBy(nextSortBy)
    setSortDirection(nextDirection)
    setPage(1)
  }

  function changeContextSearch(value: string) {
    setStatusLoading(true)
    setContextSearch(value)
    setPage(1)
  }

  function loadMoreContext() {
    if (!scope || statusLoading || contextLoadingMore || page >= totalPages) return
    void loadStatus(scope, {
      page: page + 1,
      sortBy,
      sortDirection,
      query: contextSearch,
      append: true,
    })
  }

  const hasMoreContext = recentItems.length < totalCount && page < totalPages
  const totalKnowledgeItems = knowledgeSnapshot ? countKnowledgeItems(knowledgeSnapshot.knowledgeBase) : 0
  const canLoadIndex = Boolean(scope)
    && Boolean(workItemMetadata)
    && !workItemMetadataLoading
    && !workItemMetadataError
    && workItemTypes.length > 0
    && states.length > 0
    && !buildLoading
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
            reportLoading={knowledgeReportLoading}
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
                </TabsList>
              </div>

              <CardContent className="min-w-0 max-w-full pt-4">
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
                    sortBy={sortBy}
                    sortDirection={sortDirection}
                    search={contextSearch}
                    loading={statusLoading}
                    loadingMore={contextLoadingMore}
                    hasMore={hasMoreContext}
                    error={contextStatusError}
                    emptyMessage={emptyContextMessage}
                    onSearchChange={changeContextSearch}
                    onSortChange={changeSort}
                    onLoadMore={loadMoreContext}
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
              </CardContent>
            </Tabs>
          </Card>
        </TabsContent>

        {canBuildKnowledge ? (
        <TabsContent value="build" className="space-y-4">
          {scope ? (
            <>
              <KnowledgeBuildV4
                key={`${scope.workspaceId ?? "workspace"}:${scope.projectId}`}
                scope={scope}
                sourceIndexReady={Boolean(result)}
                sourceIndexLoading={buildLoading}
                generationAvailable={generationAvailable ?? undefined}
                resumableDraft={resumableDraft}
                onRefreshAvailability={() => refreshKnowledgeStatus(scope)}
                sourceIndexContent={(
                  <>
                    <Card className="qa-card">
                      <CardHeader>
                        <CardTitle className="text-base" role="heading" aria-level={2}>Load Project Index</CardTitle>
                        <p className="text-sm leading-6 text-muted-foreground">
                          Sync the selected Azure DevOps work items, review what changed, then build project knowledge from that index.
                        </p>
                      </CardHeader>
                      <CardContent>
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
                      </CardContent>
                    </Card>

                    {buildError ? (
                      <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                        <span>{buildError}</span>
                      </div>
                    ) : null}

                    {result ? (
                      <>
                        <IndexSummary result={result} />
                        <IndexedContextPanel
                          items={recentItems}
                          totalCount={totalCount}
                          sortBy={sortBy}
                          sortDirection={sortDirection}
                          search={contextSearch}
                          loading={statusLoading}
                          loadingMore={contextLoadingMore}
                          hasMore={hasMoreContext}
                          error={contextStatusError}
                          emptyMessage="No indexed work items matched the loaded project index."
                          onSearchChange={changeContextSearch}
                          onSortChange={changeSort}
                          onLoadMore={loadMoreContext}
                        />
                      </>
                    ) : null}
                  </>
                )}
                onActivityChange={setHasUnfinishedWork}
                onPublished={async () => {
                  await Promise.all([
                    refreshKnowledgeStatus(scope),
                    refreshKnowledgeLog(scope),
                    loadStatus(scope, { page: 1, sortBy, sortDirection, query: contextSearch }),
                  ])
                }}
              />
            </>
          ) : null}
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
  sortBy: ContextSortBy
  sortDirection: ContextSortDirection
  search: string
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  emptyMessage: string
  onSearchChange: (value: string) => void
  onSortChange: (sortBy: ContextSortBy) => void
  onLoadMore: () => void
}

export function IndexedContextView({
  items,
  totalCount,
  sortBy,
  sortDirection,
  search,
  loading,
  loadingMore,
  hasMore,
  error,
  emptyMessage,
  onSearchChange,
  onSortChange,
  onLoadMore,
}: IndexedContextViewProps) {
  const scrollRegionRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (scrollRegionRef.current) scrollRegionRef.current.scrollTop = 0
  }, [search, sortBy, sortDirection])

  return (
    <>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {totalCount > 0
            ? `Showing ${items.length} of ${totalCount} active source work items available for retrieval.${loadingMore ? " Loading more." : ""}`
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

      {error ? (
        <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {!items.length && loading ? (
        <KnowledgeLoadingState label="Loading indexed project context" compact />
      ) : items.length ? (
        <div
          ref={scrollRegionRef}
          role="region"
          tabIndex={0}
          aria-label="Scrollable indexed project context"
          aria-busy={loading || loadingMore}
          className="max-h-[min(68vh,680px)] overflow-auto overscroll-contain rounded-lg border border-border bg-card outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <div className="min-w-[760px]">
            <Table containerClassName="overflow-visible" className={`transition-opacity duration-ui motion-reduce:transition-none ${loading ? "opacity-60" : ""}`}>
              <TableHeader className="sticky top-0 z-10 bg-card shadow-[0_1px_0_hsl(var(--border))]">
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
            <div className="flex min-h-14 items-center justify-center border-t border-border bg-card/95 px-4 py-3 text-sm text-muted-foreground backdrop-blur-sm">
              {hasMore ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={loading || loadingMore}
                  onClick={onLoadMore}
                  aria-label={`Load more indexed project context. ${items.length} of ${totalCount} currently shown.`}
                >
                  {loadingMore ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
                  {loadingMore ? "Loading more..." : "Load more"}
                </Button>
              ) : (
                <span className="flex items-center gap-2">
                  <Check className="size-4 text-success" aria-hidden="true" />
                  All {totalCount} active source work items loaded
                </span>
              )}
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

export function IndexSummary({ result }: { result: IndexResult }) {
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

export function KnowledgeOpsPanel({
  lint,
  logItems,
  logVisible,
  exportResult,
  healthLoading,
  logLoading,
  exportLoading,
  reportLoading,
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
  reportLoading: boolean
  canManage: boolean
  onRunHealthCheck: () => void
  onToggleLog: () => void
  onExport: () => void
  onReportMiss: (input: { missType: "duplicate" | "conflict"; title: string; message: string }) => Promise<boolean>
  onTransitionIssue: (issueId: string, action: "confirm" | "reject" | "ignore" | "reopen") => Promise<void>
}) {
  const [missType, setMissType] = useState<"duplicate" | "conflict">("duplicate")
  const [missTitle, setMissTitle] = useState("")
  const [missMessage, setMissMessage] = useState("")
  const [missSubmitted, setMissSubmitted] = useState(false)

  async function submitMiss() {
    if (!missTitle.trim() || !missMessage.trim()) return
    setMissSubmitted(false)
    const reported = await onReportMiss({ missType, title: missTitle.trim(), message: missMessage.trim() })
    if (!reported) return
    setMissTitle("")
    setMissMessage("")
    setMissSubmitted(true)
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
          {lint.issues.length > 5 ? (
            <p className="text-xs text-muted-foreground">Showing 5 of {lint.issues.length} issues.</p>
          ) : null}
        </div>
      ) : lint ? (
        <div className="rounded-md border border-success/30 bg-success/10 p-3 text-sm text-success">
          Knowledge health check passed without open issues.
        </div>
      ) : null}

      <Accordion type="single" collapsible>
        <AccordionItem
          value="report-missed-knowledge-issue"
          className="border-primary/25 bg-gradient-to-br from-primary/10 via-card to-info/10 shadow-sm transition-colors duration-ui motion-reduce:transition-none dark:border-primary/30"
        >
          <AccordionTrigger className="min-h-16 items-start py-4 hover:bg-primary/5 motion-reduce:transition-none [&>svg]:mt-2">
            <div className="flex min-w-0 flex-1 items-start gap-3 pr-1">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
                <MessageSquareWarning className="size-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">Report a missed duplicate or conflict</span>
                </span>
                <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                  Help improve semantic lint by flagging related knowledge that the automated check missed.
                </span>
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="bg-card/90 p-4">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                void submitMiss()
              }}
            >
              <p id="knowledge-miss-description" className="text-xs leading-5 text-muted-foreground">
                Reports do not change knowledge. Owners or admins must confirm them before they count toward semantic-lint expansion.
              </p>
              <div className="grid gap-3 md:grid-cols-[180px_1fr]">
                <div className="space-y-1">
                  <Label htmlFor="knowledge-miss-type" className="text-xs">Miss type</Label>
                  <select
                    id="knowledge-miss-type"
                    value={missType}
                    onChange={(event) => {
                      setMissType(event.target.value as "duplicate" | "conflict")
                      setMissSubmitted(false)
                    }}
                    disabled={reportLoading}
                    aria-describedby="knowledge-miss-description"
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors duration-ui focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
                  >
                    <option value="duplicate">Duplicate</option>
                    <option value="conflict">Conflict</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="knowledge-miss-title" className="text-xs">Title</Label>
                  <Input
                    id="knowledge-miss-title"
                    value={missTitle}
                    onChange={(event) => {
                      setMissTitle(event.target.value)
                      setMissSubmitted(false)
                    }}
                    maxLength={200}
                    placeholder="What deterministic lint missed"
                    disabled={reportLoading}
                    required
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="knowledge-miss-evidence" className="text-xs">Evidence and impact</Label>
                <Textarea
                  id="knowledge-miss-evidence"
                  value={missMessage}
                  onChange={(event) => {
                    setMissMessage(event.target.value)
                    setMissSubmitted(false)
                  }}
                  maxLength={2000}
                  placeholder="Describe the entries, concrete mismatch, and relevant source IDs."
                  disabled={reportLoading}
                  required
                />
              </div>
              <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
                <div role="status" aria-live="polite" className="min-h-5 text-sm text-success">
                  {missSubmitted ? (
                    <span className="flex items-center gap-2">
                      <Check className="size-4" aria-hidden="true" />
                      Report submitted for review.
                    </span>
                  ) : null}
                </div>
                <Button type="submit" size="sm" disabled={reportLoading || !missTitle.trim() || !missMessage.trim()} aria-busy={reportLoading}>
                  {reportLoading ? <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                  {reportLoading ? "Reporting..." : "Report miss"}
                </Button>
              </div>
            </form>
          </AccordionContent>
        </AccordionItem>
      </Accordion>

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

export function KnowledgeExplorer({
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
  const scrollRegionRef = useRef<HTMLDivElement | null>(null)
  const entries = useMemo(() => flattenKnowledgeEntries(knowledgeBase), [knowledgeBase])
  const counts = useMemo(() => getKnowledgeCategoryCounts(knowledgeBase), [knowledgeBase])
  const deferredQuery = useDeferredValue(query)
  const normalizedQuery = normalizeSearch(deferredQuery)
  const filteredEntries = useMemo(() => entries.filter((entry) => {
    const categoryMatch = category === "all" || entry.category === category
    const textMatch = !normalizedQuery || entry.searchText.includes(normalizedQuery)
    return categoryMatch && textMatch
  }), [category, entries, normalizedQuery])
  const highlightedEntryIdentitySet = useMemo(
    () => new Set(highlightedEntryIdentities),
    [highlightedEntryIdentities],
  )
  const pageSize = 5
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const pageStart = filteredEntries.length === 0 ? 0 : (safePage - 1) * pageSize + 1
  const pageEnd = Math.min(filteredEntries.length, safePage * pageSize)
  const visibleEntries = compact
    ? filteredEntries.slice((safePage - 1) * pageSize, safePage * pageSize)
    : filteredEntries

  useEffect(() => {
    setPage(1)
    if (scrollRegionRef.current) scrollRegionRef.current.scrollTop = 0
  }, [category, deferredQuery, compact, knowledgeBase])

  useEffect(() => {
    const highlightedIndex = entries.findIndex((entry) => highlightedEntryIdentities.includes(entry.highlightIdentity))
    if (highlightedIndex < 0) return
    setCategory("all")
    setQuery("")
    setPage(Math.floor(highlightedIndex / pageSize) + 1)
  }, [entries, highlightedEntryIdentities, pageSize])

  return (
    <div className="w-full min-w-0 max-w-full space-y-3">
      <div className="flex min-w-0 max-w-full flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
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
      <div className={`grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-4 ${compact ? "lg:grid-cols-[208px_minmax(0,1fr)]" : "lg:grid-cols-[216px_minmax(0,1fr)]"}`}>
        <div className="-mx-1 min-w-0 max-w-full px-1 lg:mx-0 lg:px-0">
          <div role="group" aria-label="Knowledge categories" className="flex min-w-0 max-w-full flex-wrap gap-1 lg:block lg:space-y-1">
            <KnowledgeCategoryFilterButton
              label="All"
              iconKey="all"
              count={entries.length}
              active={category === "all"}
              onClick={() => setCategory("all")}
            />
            {KNOWLEDGE_CATEGORIES.map((item) => (
              <KnowledgeCategoryFilterButton
                key={item.key}
                label={item.label}
                iconKey={item.iconKey}
                count={counts[item.key]}
                active={category === item.key}
                onClick={() => setCategory(item.key)}
              />
            ))}
          </div>
        </div>
        <div
          ref={scrollRegionRef}
          role="region"
          tabIndex={0}
          aria-label={compact ? "Scrollable knowledge preview" : "Scrollable knowledge explorer results"}
          className={`w-full min-w-0 max-w-full space-y-3 overflow-x-clip overflow-y-auto overscroll-contain pr-2 outline-none [scrollbar-gutter:stable] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
            compact ? "max-h-[520px]" : "max-h-[min(68vh,680px)]"
          }`}
        >
          {visibleEntries.length ? (
            visibleEntries.map((entry) => (
              <KnowledgeEntryCard
                key={entry.key}
                entry={entry}
                compact={compact}
                highlighted={highlightedEntryIdentitySet.has(entry.highlightIdentity)}
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
          {compact && filteredEntries.length > pageSize ? (
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

function KnowledgeLoadingState({ label, compact = false }: { label: string; compact?: boolean }) {
  const rows = Array.from({ length: compact ? 2 : 4 }).map((_, index) => (
    <div key={index} className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
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
    </div>
  ))

  return (
    <div role="status" aria-live="polite" aria-label={label} className="min-w-0 max-w-full space-y-3">
      <span className="sr-only">{label}</span>
      {compact ? (
        <div className="space-y-3">{rows}</div>
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full lg:w-[420px]" />
          </div>
          <div className="grid min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[216px_minmax(0,1fr)]">
            <div className="min-w-0 max-w-full space-y-1">
              {Array.from({ length: 5 }).map((_, index) => (
                <Skeleton key={index} className="h-10 w-full" />
              ))}
            </div>
            <div className="min-w-0 max-w-full space-y-3">{rows}</div>
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
      const details = knowledgeDetails(category.key, item)
      const evidenceItems = item.evidenceRefs?.map((evidence) => ({
        sourceWorkItemId: evidence.sourceWorkItemId,
        sourceField: evidence.sourceField,
        quote: evidence.quote,
      }))
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
        details,
        evidenceItems,
        searchText: normalizeSearch([
          category.label,
          title,
          description,
          item.evidence,
          ...item.sourceWorkItemIds,
          ...meta,
          ...details.flatMap((detail) => [detail.id, detail.label, detail.value]),
          ...(evidenceItems ?? []).flatMap((evidence) => [
            evidence.sourceWorkItemId,
            evidence.sourceField,
            evidence.quote,
          ]),
        ].join(" ")),
      }
    })
  })
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

function knowledgeDetails(category: KnowledgeCategoryKey, item: AnyKnowledgeItem) {
  const details = category === "modules"
    ? [
        knowledgeDetail("id", "ID", item.id),
        knowledgeDetail("name", "Name", item.name),
        knowledgeDetail("description", "Description", item.description),
      ]
    : category === "businessRules"
      ? [
          knowledgeDetail("id", "ID", item.id),
          knowledgeDetail("rule", "Rule", item.rule),
          knowledgeDetail("sourceField", "Source field", item.sourceField),
          knowledgeDetail("moduleName", "Module", item.moduleName),
        ]
      : category === "stateTransitions"
        ? [
            knowledgeDetail("id", "ID", item.id),
            knowledgeDetail("workflowName", "Workflow", item.workflowName),
            knowledgeDetail("fromState", "From state", item.fromState),
            knowledgeDetail("toState", "To state", item.toState),
            knowledgeDetail("triggerOrCondition", "Trigger or condition", item.triggerOrCondition),
            knowledgeDetail("actor", "Actor", item.actor),
            knowledgeDetail("moduleName", "Module", item.moduleName),
          ]
        : category === "glossary"
          ? [
              knowledgeDetail("term", "Term", item.term),
              knowledgeDetail("type", "Type", formatGlossaryType(item.type)),
              knowledgeDetail("definition", "Definition", item.definition),
            ]
          : [
              knowledgeDetail("id", "ID", item.id),
              knowledgeDetail("sourceModule", "Source", item.sourceModule),
              knowledgeDetail("targetModule", "Target", item.targetModule),
              knowledgeDetail("dependencyType", "Dependency type", item.dependencyType),
              knowledgeDetail("description", "Description", item.description),
            ]

  return details.filter((detail): detail is NonNullable<typeof detail> => Boolean(detail))
}

function knowledgeDetail(id: string, label: string, value?: string) {
  const normalized = value?.trim()
  return normalized ? { id, label, value: normalized } : null
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
