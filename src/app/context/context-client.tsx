"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, ArrowUpDown, BookOpen, Copy, Database, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContextFilterSelector } from "@/components/domain/context-filter-selector"
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
  CONTEXT_STATE_OPTIONS,
  CONTEXT_WORK_ITEM_TYPE_OPTIONS,
  DEFAULT_CONTEXT_STATES,
  DEFAULT_CONTEXT_WORK_ITEM_TYPES,
} from "@/lib/project-context-defaults"
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project"

type IndexResult = {
  fetchedCount: number
  storedWorkItemCount: number
  indexedWorkItemCount: number
  indexedChunkCount: number
  skippedEmptyCount: number
  workItemTypes: string[]
  states: string[]
}

type RecentContextItem = {
  workItemId: string
  workItemType: string
  title: string
  state?: string | null
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
}

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
  knowledgeBase: ProjectKnowledgeBase
  status: string
  extractedAt: string
}

type KnowledgeStatusResult = {
  snapshot: ProjectKnowledgeSnapshot | null
}

type KnowledgeManualBatchPrompt = {
  batchIndex: number
  batchCount: number
  workItemCount: number
  prompt: string
}

type KnowledgeManualDraft = {
  promptVersion: string
  sourceWorkItemCount: number
  batchCount: number
  batches: KnowledgeManualBatchPrompt[]
}

type KnowledgeManualValidationResult = {
  knowledgeBase: ProjectKnowledgeBase
  snapshot?: ProjectKnowledgeSnapshot
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  const [activeTab, setActiveTab] = useState<"step1" | "step2">("step1")
  const [workItemTypes, setWorkItemTypes] = useState<string[]>(DEFAULT_CONTEXT_WORK_ITEM_TYPES)
  const [states, setStates] = useState<string[]>(DEFAULT_CONTEXT_STATES)
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IndexResult | null>(null)
  const [recentItems, setRecentItems] = useState<RecentContextItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [knowledgeLoading, setKnowledgeLoading] = useState(false)
  const [knowledgeStatusLoading, setKnowledgeStatusLoading] = useState(false)
  const [knowledgeError, setKnowledgeError] = useState<string | null>(null)
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState<ProjectKnowledgeSnapshot | null>(null)
  const [knowledgeMode, setKnowledgeMode] = useState<"auto" | "manual">("auto")
  const [manualKnowledgeDraftLoading, setManualKnowledgeDraftLoading] = useState(false)
  const [manualKnowledgeDraft, setManualKnowledgeDraft] = useState<KnowledgeManualDraft | null>(null)
  const [manualKnowledgeCurrentBatch, setManualKnowledgeCurrentBatch] = useState(1)
  const [manualKnowledgeBatchResponses, setManualKnowledgeBatchResponses] = useState<Record<number, string>>({})
  const [manualKnowledgeValidatedBatches, setManualKnowledgeValidatedBatches] = useState<Record<number, ProjectKnowledgeBase>>({})
  const [manualKnowledgeValidationLoading, setManualKnowledgeValidationLoading] = useState(false)
  const [manualKnowledgeError, setManualKnowledgeError] = useState<string | null>(null)
  const [manualKnowledgeSaveLoading, setManualKnowledgeSaveLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize] = useState(25)
  const [totalPages, setTotalPages] = useState(1)
  const [sortBy, setSortBy] = useState<ContextSortBy>("lastIndexedAt")
  const [sortDirection, setSortDirection] = useState<ContextSortDirection>("desc")

  useEffect(() => {
    setScope(readActiveProject())
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>
      setScope(custom.detail ?? readActiveProject())
    }
    window.addEventListener("itestflow:active-project-changed", onChange)
    return () => window.removeEventListener("itestflow:active-project-changed", onChange)
  }, [])

  const loadStatus = useCallback(async (
    activeScope = scope,
    options?: {
      page?: number
      sortBy?: ContextSortBy
      sortDirection?: ContextSortDirection
    },
  ) => {
    if (!activeScope) return
    setStatusLoading(true)
    try {
      const data = await postJson<ContextStatusResult>("/api/context/status", {
        scope: activeScope,
        page: options?.page ?? page,
        pageSize,
        sortBy: options?.sortBy ?? sortBy,
        sortDirection: options?.sortDirection ?? sortDirection,
      })
      setRecentItems(data.items)
      setTotalCount(data.totalCount)
      setTotalPages(data.totalPages)
      if (data.page !== page) setPage(data.page)
      if (data.sortBy !== sortBy) setSortBy(data.sortBy)
      if (data.sortDirection !== sortDirection) setSortDirection(data.sortDirection)
    } catch {
      setRecentItems([])
      setTotalCount(0)
      setTotalPages(1)
    } finally {
      setStatusLoading(false)
    }
  }, [page, pageSize, scope, sortBy, sortDirection])

  useEffect(() => {
    if (!scope) return
    let cancelled = false

    setActiveTab("step1")
    setResult(null)
    setError(null)
    setKnowledgeError(null)
    setManualKnowledgeError(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    setPage(1)
    setSortBy("lastIndexedAt")
    setSortDirection("desc")
    setStatusLoading(true)
    setKnowledgeStatusLoading(true)

    void postJson<ContextStatusResult>("/api/context/status", {
      scope,
      page: 1,
      pageSize,
      sortBy: "lastIndexedAt",
      sortDirection: "desc",
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

    return () => {
      cancelled = true
    }
  }, [pageSize, scope])

  async function indexContext() {
    if (!scope) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const data = await postJson<IndexResult>("/api/context/index", {
        scope,
        workItemTypes,
        states,
      })
      setResult(data)
      setPage(1)
      await loadStatus(scope, { page: 1 })
    } catch (indexError) {
      setError(indexError instanceof Error ? indexError.message : "Project context indexing failed.")
    } finally {
      setLoading(false)
    }
  }

  async function extractKnowledgeBase() {
    if (!scope) return
    setKnowledgeLoading(true)
    setKnowledgeError(null)
    try {
      const data = await postJson<ProjectKnowledgeSnapshot>("/api/context/knowledge/extract", {
        scope,
      })
      setKnowledgeSnapshot(data)
    } catch (extractError) {
      setKnowledgeError(extractError instanceof Error ? extractError.message : "Project knowledge extraction failed.")
    } finally {
      setKnowledgeLoading(false)
    }
  }

  async function prepareManualKnowledgeDraft() {
    if (!scope) return
    setManualKnowledgeDraftLoading(true)
    setManualKnowledgeError(null)
    setManualKnowledgeDraft(null)
    setManualKnowledgeCurrentBatch(1)
    setManualKnowledgeBatchResponses({})
    setManualKnowledgeValidatedBatches({})
    try {
      const data = await postJson<KnowledgeManualDraft>("/api/context/knowledge/manual/draft", { scope })
      setManualKnowledgeDraft(data)
    } catch (draftError) {
      setManualKnowledgeError(draftError instanceof Error ? draftError.message : "External LLM knowledge prompt preparation failed.")
    } finally {
      setManualKnowledgeDraftLoading(false)
    }
  }

  async function validateManualKnowledgeBatch() {
    if (!scope || !manualKnowledgeDraft) return
    const batch = manualKnowledgeDraft.batches.find((item) => item.batchIndex === manualKnowledgeCurrentBatch)
    if (!batch) return
    const rawOutput = manualKnowledgeBatchResponses[batch.batchIndex]?.trim()
    if (!rawOutput) return

    setManualKnowledgeValidationLoading(true)
    setManualKnowledgeError(null)
    try {
      const shouldSave = manualKnowledgeDraft.batchCount === 1
      const data = await postJson<KnowledgeManualValidationResult>("/api/context/knowledge/manual/validate", {
        scope,
        rawOutput,
        save: shouldSave,
      })

      if (shouldSave && data.snapshot) {
        setKnowledgeSnapshot(data.snapshot)
        return
      }

      const nextValidated = {
        ...manualKnowledgeValidatedBatches,
        [batch.batchIndex]: data.knowledgeBase,
      }
      setManualKnowledgeValidatedBatches(nextValidated)
      const nextBatch = manualKnowledgeDraft.batches.find((item) => !nextValidated[item.batchIndex])
      if (nextBatch) setManualKnowledgeCurrentBatch(nextBatch.batchIndex)
    } catch (validationError) {
      setManualKnowledgeError(validationError instanceof Error ? validationError.message : "External LLM knowledge response validation failed.")
    } finally {
      setManualKnowledgeValidationLoading(false)
    }
  }

  async function saveManualKnowledgeBatches() {
    if (!scope || !manualKnowledgeDraft) return
    const partialKnowledgeBases = manualKnowledgeDraft.batches
      .map((batch) => manualKnowledgeValidatedBatches[batch.batchIndex])
      .filter(Boolean)
    if (partialKnowledgeBases.length !== manualKnowledgeDraft.batchCount) return

    setManualKnowledgeSaveLoading(true)
    setManualKnowledgeError(null)
    try {
      const data = await postJson<KnowledgeManualValidationResult>("/api/context/knowledge/manual/finalize", {
        scope,
        partialKnowledgeBases,
      })
      if (data.snapshot) setKnowledgeSnapshot(data.snapshot)
    } catch (saveError) {
      setManualKnowledgeError(saveError instanceof Error ? saveError.message : "External LLM knowledge base save failed.")
    } finally {
      setManualKnowledgeSaveLoading(false)
    }
  }

  function changeSort(nextSortBy: ContextSortBy) {
    const nextDirection = sortBy === nextSortBy && sortDirection === "asc" ? "desc" : "asc"
    setSortBy(nextSortBy)
    setSortDirection(nextDirection)
    setPage(1)
    if (scope) void loadStatus(scope, { page: 1, sortBy: nextSortBy, sortDirection: nextDirection })
  }

  function changePage(nextPage: number) {
    const safePage = Math.min(Math.max(1, nextPage), totalPages)
    setPage(safePage)
    if (scope) void loadStatus(scope, { page: safePage })
  }

  const canIndex = Boolean(scope) && workItemTypes.length > 0 && states.length > 0 && !loading
  const step2Unlocked = totalCount > 0 || (result?.indexedWorkItemCount ?? 0) > 0
  const canExtractKnowledge = Boolean(scope) && step2Unlocked && !knowledgeLoading
  const currentManualKnowledgeBatch = manualKnowledgeDraft?.batches.find((batch) => batch.batchIndex === manualKnowledgeCurrentBatch)
  const manualKnowledgeValidatedCount = manualKnowledgeDraft
    ? manualKnowledgeDraft.batches.filter((batch) => manualKnowledgeValidatedBatches[batch.batchIndex]).length
    : 0
  const manualKnowledgeAllBatchesValidated = manualKnowledgeDraft
    ? manualKnowledgeValidatedCount === manualKnowledgeDraft.batchCount
    : false
  const rangeStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(totalCount, rangeStart + recentItems.length - 1)

  return (
    <div className="space-y-4">
      {!scope ? (
        <div className="flex items-center gap-2 rounded-md border border-[#F5CD47]/60 bg-[#FFF7D6] p-3 text-sm text-[#7F5F01]">
          <AlertTriangle className="size-4" />
          Select an Azure DevOps project before indexing context.
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "step2" && !step2Unlocked) return
          setActiveTab(value as "step1" | "step2")
        }}
        className="flex-col gap-4"
      >
        <TabsList className="grid h-auto w-full grid-cols-2 rounded-md border border-[#DCDFE4] bg-white p-1 sm:inline-grid sm:w-fit sm:min-w-[520px]">
          <TabsTrigger value="step1" className="h-10 px-3 py-2">
            <span>Step 1</span>
            <span className="hidden text-xs text-[#626F86] sm:inline">Fetch and Index Context</span>
          </TabsTrigger>
          <TabsTrigger
            value="step2"
            disabled={!step2Unlocked}
            className="h-10 px-3 py-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span>Step 2</span>
            <span className="hidden text-xs text-[#626F86] sm:inline">Extract Knowledge Base</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="step1" className="space-y-4">
          <Card className="qa-card">
            <CardHeader>
              <CardTitle className="text-base">Step 1 - Fetch and Index Context</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <ContextFilterSelector
                title="Work item types"
                description="Custom values must match Azure DevOps work item type names exactly."
                options={CONTEXT_WORK_ITEM_TYPE_OPTIONS}
                selectedValues={workItemTypes}
                customPlaceholder="Add work item type"
                duplicateMessage="This work item type is already selected."
                optionGridClassName="sm:grid-cols-2 lg:grid-cols-3"
                onChange={setWorkItemTypes}
              />
              <ContextFilterSelector
                title="States"
                description="Custom values must match Azure DevOps state names exactly."
                options={CONTEXT_STATE_OPTIONS}
                selectedValues={states}
                customPlaceholder="Add state"
                duplicateMessage="This state is already selected."
                optionGridClassName="sm:grid-cols-2 lg:grid-cols-3"
                onChange={setStates}
              />
              <div className="flex flex-col gap-3 border-t border-[#EBECF0] pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-[#626F86]">
                  Indexed context is stored locally and reused by requirement analysis and test design.
                </p>
                <Button onClick={indexContext} disabled={!canIndex}>
                  {loading ? <RefreshCw className="size-4 animate-spin" /> : <Database className="size-4" />}
                  {loading ? "Indexing context..." : "Fetch and Index Context"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          {result ? <IndexSummary result={result} /> : null}

          <Card className="qa-card">
            <CardHeader>
              <CardTitle className="text-base">Indexed Project Context</CardTitle>
            </CardHeader>
            <CardContent>
              {statusLoading ? (
                <div className="text-sm text-[#626F86]">Loading indexed context...</div>
              ) : recentItems.length ? (
                <div className="space-y-3">
                  <div className="text-sm text-[#626F86]">
                    Showing {rangeStart}-{rangeEnd} of {totalCount} indexed work items available for retrieval.
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>ID</TableHead>
                          <TableHead>
                            <SortHeader label="Type" active={sortBy === "type"} direction={sortDirection} onClick={() => changeSort("type")} />
                          </TableHead>
                          <TableHead className="min-w-[320px]">Title</TableHead>
                          <TableHead>Chunks</TableHead>
                          <TableHead>
                            <SortHeader
                              label="Last Indexed"
                              active={sortBy === "lastIndexedAt"}
                              direction={sortDirection}
                              onClick={() => changeSort("lastIndexedAt")}
                            />
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {recentItems.map((item) => (
                          <TableRow key={item.workItemId}>
                            <TableCell className="font-mono text-xs font-semibold text-[#0C66E4]">{item.workItemId}</TableCell>
                            <TableCell><Badge variant="secondary">{item.workItemType}</Badge></TableCell>
                            <TableCell className="font-medium text-[#172B4D]">{item.title}</TableCell>
                            <TableCell>{item.chunkCount}</TableCell>
                            <TableCell>{formatDate(item.lastIndexedAt)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="flex items-center justify-between border-t border-[#EBECF0] pt-3 text-sm text-[#626F86]">
                    <span>Page {page} of {totalPages}</span>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={page <= 1 || statusLoading} onClick={() => changePage(page - 1)}>
                        Previous
                      </Button>
                      <Button size="sm" variant="outline" disabled={page >= totalPages || statusLoading} onClick={() => changePage(page + 1)}>
                        Next
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-md border border-[#DCDFE4] bg-white p-6 text-sm text-[#626F86]">
                  No project context has been indexed yet. After ingestion, analysis and test design can retrieve stored context from this local knowledge base.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="step2" className="space-y-4">
          <Card className="qa-card">
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <CardTitle className="text-base">Step 2 - Extract Knowledge Base</CardTitle>
                {knowledgeSnapshot ? <Badge variant="outline">Prompt {knowledgeSnapshot.promptVersion}</Badge> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={knowledgeMode} onValueChange={(value) => setKnowledgeMode(value as "auto" | "manual")} className="flex-col gap-4">
                <TabsList className="h-auto w-fit rounded-md border border-[#DCDFE4] bg-white p-1">
                  <TabsTrigger value="auto" className="h-9 px-3">Auto Generate</TabsTrigger>
                  <TabsTrigger value="manual" className="h-9 px-3">External LLM</TabsTrigger>
                </TabsList>

                <TabsContent value="auto" className="space-y-4">
                  <div className="flex flex-col gap-3 border-b border-[#EBECF0] pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-[#626F86]">
                      Extract modules, business rules, workflows, glossary terms, and dependencies from the indexed context.
                    </p>
                    <Button onClick={extractKnowledgeBase} disabled={!canExtractKnowledge}>
                      {knowledgeLoading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
                      {knowledgeLoading ? "Extracting..." : "Extract Knowledge Base"}
                    </Button>
                  </div>

                  {knowledgeError ? (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700">
                      {knowledgeError}
                    </div>
                  ) : null}
                </TabsContent>

                <TabsContent value="manual" className="space-y-4">
                  <div className="flex flex-col gap-3 border-b border-[#EBECF0] pb-4 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-[#626F86]">
                      Copy each generated prompt to an external LLM, paste the JSON response, then validate it here.
                    </p>
                    <Button onClick={prepareManualKnowledgeDraft} disabled={!canExtractKnowledge || manualKnowledgeDraftLoading}>
                      {manualKnowledgeDraftLoading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
                      {manualKnowledgeDraftLoading ? "Preparing..." : "Prepare External LLM Prompt"}
                    </Button>
                  </div>

                  {manualKnowledgeError ? (
                    <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700">
                      {manualKnowledgeError}
                    </div>
                  ) : null}

                  {manualKnowledgeDraft && currentManualKnowledgeBatch ? (
                    <div className="space-y-4 rounded-md border border-[#DCDFE4] bg-[#F7F8F9] p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-semibold text-[#172B4D]">
                            Batch {currentManualKnowledgeBatch.batchIndex} of {manualKnowledgeDraft.batchCount}
                          </div>
                          <div className="text-xs text-[#626F86]">
                            {currentManualKnowledgeBatch.workItemCount} work items in this prompt. {manualKnowledgeValidatedCount} validated.
                          </div>
                        </div>
                        <Button variant="outline" onClick={() => void navigator.clipboard.writeText(currentManualKnowledgeBatch.prompt)}>
                          <Copy className="size-4" />
                          Copy Prompt
                        </Button>
                      </div>
                      <Textarea value={currentManualKnowledgeBatch.prompt} readOnly className="min-h-[360px] font-mono text-xs" />
                      <div className="space-y-2">
                        <Label className="text-sm font-semibold text-[#172B4D]">External LLM Response</Label>
                        <Textarea
                          value={manualKnowledgeBatchResponses[currentManualKnowledgeBatch.batchIndex] ?? ""}
                          onChange={(event) =>
                            setManualKnowledgeBatchResponses((current) => ({
                              ...current,
                              [currentManualKnowledgeBatch.batchIndex]: event.target.value,
                            }))
                          }
                          className="min-h-[240px] font-mono text-xs"
                          placeholder="Paste the JSON response for this batch."
                        />
                      </div>
                      <div className="flex justify-end">
                        <Button
                          onClick={validateManualKnowledgeBatch}
                          disabled={!manualKnowledgeBatchResponses[currentManualKnowledgeBatch.batchIndex]?.trim() || manualKnowledgeValidationLoading}
                        >
                          {manualKnowledgeValidationLoading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
                          {manualKnowledgeDraft.batchCount === 1 ? "Validate and Save" : "Validate Batch"}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {manualKnowledgeDraft && manualKnowledgeDraft.batchCount > 1 && manualKnowledgeAllBatchesValidated ? (
                    <div className="space-y-4 rounded-md border border-[#DCDFE4] bg-white p-4">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <div className="text-sm font-semibold text-[#172B4D]">Ready to Save Knowledge Base</div>
                          <div className="text-xs text-[#626F86]">
                            All {manualKnowledgeDraft.batchCount} batch responses are validated. iTestFlow will merge duplicates locally and save the final
                            knowledge base.
                          </div>
                        </div>
                        <Button onClick={saveManualKnowledgeBatches} disabled={manualKnowledgeSaveLoading}>
                          {manualKnowledgeSaveLoading ? <RefreshCw className="size-4 animate-spin" /> : <BookOpen className="size-4" />}
                          {manualKnowledgeSaveLoading ? "Saving..." : "Save Knowledge Base"}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </TabsContent>
              </Tabs>

              {knowledgeStatusLoading ? (
                <div className="text-sm text-[#626F86]">Loading saved knowledge base...</div>
              ) : knowledgeSnapshot ? (
                <KnowledgeBaseSummary snapshot={knowledgeSnapshot} />
              ) : (
                <div className="rounded-md border border-[#DCDFE4] bg-white p-6 text-sm text-[#626F86]">
                  No knowledge base has been extracted yet. Run Step 2 after indexing context to save categorized project knowledge for analysis and test design.
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
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
    <Button variant="ghost" size="sm" className="-ml-3 h-8 px-2 text-[#172B4D]" onClick={onClick}>
      {label}
      <ArrowUpDown className="size-3.5" />
      {active ? <span className="text-xs text-[#626F86]">{direction === "asc" ? "Asc" : "Desc"}</span> : null}
    </Button>
  )
}

function IndexSummary({ result }: { result: IndexResult }) {
  const metrics = [
    ["Fetched", result.fetchedCount],
    ["Stored", result.storedWorkItemCount],
    ["Work items indexed", result.indexedWorkItemCount],
    ["Chunks indexed", result.indexedChunkCount],
    ["Skipped empty", result.skippedEmptyCount],
  ] as const

  return (
    <Card className="qa-card">
      <CardHeader>
        <CardTitle className="text-base">Latest Indexing Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {metrics.map(([label, value]) => (
            <div key={label} className="rounded-md border border-[#DCDFE4] bg-white p-3">
              <div className="text-xs text-[#626F86]">{label}</div>
              <div className="mt-1 text-lg font-semibold text-[#172B4D]">{value}</div>
            </div>
          ))}
        </div>
        <div className="grid gap-3 text-sm text-[#44546F] lg:grid-cols-2">
          <div><span className="font-semibold">Types:</span> {result.workItemTypes.join(", ")}</div>
          <div><span className="font-semibold">States:</span> {result.states.join(", ")}</div>
        </div>
      </CardContent>
    </Card>
  )
}

const KNOWLEDGE_CATEGORIES = [
  { key: "modules", label: "Modules" },
  { key: "businessRules", label: "Business Rules" },
  { key: "stateTransitions", label: "State Transitions" },
  { key: "glossary", label: "Glossary" },
  { key: "crossDependencies", label: "Dependencies" },
] as const

type KnowledgeCategoryKey = (typeof KNOWLEDGE_CATEGORIES)[number]["key"]

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

function KnowledgeBaseSummary({ snapshot }: { snapshot: ProjectKnowledgeSnapshot }) {
  const counts = KNOWLEDGE_CATEGORIES.map(({ key, label }) => ({
    key,
    label,
    value: snapshot.knowledgeBase[key].length,
  }))

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {counts.map((count) => (
          <div key={count.key} className="rounded-md border border-[#DCDFE4] bg-white p-3">
            <div className="text-xs text-[#626F86]">{count.label}</div>
            <div className="mt-1 text-lg font-semibold text-[#172B4D]">{count.value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 text-sm text-[#44546F] lg:grid-cols-3">
        <div><span className="font-semibold">Source items:</span> {snapshot.sourceWorkItemCount}</div>
        <div><span className="font-semibold">Model:</span> {[snapshot.provider, snapshot.model].filter(Boolean).join(" / ") || "-"}</div>
        <div><span className="font-semibold">Extracted:</span> {formatDate(snapshot.extractedAt)}</div>
      </div>
      <KnowledgeBaseTabs knowledgeBase={snapshot.knowledgeBase} />
    </div>
  )
}

function KnowledgeBaseTabs({ knowledgeBase }: { knowledgeBase: ProjectKnowledgeBase }) {
  return (
    <Tabs defaultValue="modules" className="flex-col gap-3">
      <div className="overflow-x-auto pb-1">
        <TabsList className="h-auto min-w-max flex-wrap justify-start">
          {KNOWLEDGE_CATEGORIES.map((category) => (
            <TabsTrigger key={category.key} value={category.key} className="px-2 py-1">
              {category.label}
              <span className="rounded-sm bg-[#F1F2F4] px-1.5 py-0.5 text-xs text-[#44546F]">
                {knowledgeBase[category.key].length}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {KNOWLEDGE_CATEGORIES.map((category) => {
        const items = knowledgeBase[category.key] as AnyKnowledgeItem[]
        return (
          <TabsContent key={category.key} value={category.key} className="space-y-3">
            {items.length ? (
              items.map((item, index) => (
                <KnowledgeEntry key={knowledgeItemKey(category.key, item, index)} category={category.key} item={item} />
              ))
            ) : (
              <div className="rounded-md border border-[#DCDFE4] bg-white p-5 text-sm text-[#626F86]">
                No supported {category.label.toLowerCase()} were found in the indexed context.
              </div>
            )}
          </TabsContent>
        )
      })}
    </Tabs>
  )
}

function KnowledgeEntry({ category, item }: { category: KnowledgeCategoryKey; item: AnyKnowledgeItem }) {
  return (
    <div className="rounded-md border border-[#DCDFE4] bg-white p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="font-semibold text-[#172B4D]">{knowledgeTitle(category, item)}</div>
          <div className="mt-1 text-sm text-[#44546F]">{knowledgeDescription(category, item)}</div>
        </div>
        <div className="flex flex-wrap gap-1">
          {item.sourceWorkItemIds.map((id) => (
            <Badge key={id} variant="outline" className="font-mono text-xs">{id}</Badge>
          ))}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#626F86]">
        {item.moduleName ? <Badge variant="secondary">{item.moduleName}</Badge> : null}
        {item.sourceField ? <Badge variant="secondary">{item.sourceField}</Badge> : null}
        {category === "glossary" ? <Badge variant="secondary">{formatGlossaryType(item.type)}</Badge> : null}
        {item.dependencyType ? <Badge variant="secondary">{item.dependencyType}</Badge> : null}
        {item.actor ? <Badge variant="secondary">Actor: {item.actor}</Badge> : null}
      </div>
      <div className="mt-3 rounded-md bg-[#F7F8F9] p-3 text-sm text-[#44546F]">
        <span className="font-semibold text-[#172B4D]">Evidence:</span> {item.evidence}
      </div>
    </div>
  )
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
