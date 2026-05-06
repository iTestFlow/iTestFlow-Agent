"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, ArrowUpDown, Database, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
  const [workItemTypes, setWorkItemTypes] = useState<string[]>(DEFAULT_CONTEXT_WORK_ITEM_TYPES)
  const [states, setStates] = useState<string[]>(DEFAULT_CONTEXT_STATES)
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<IndexResult | null>(null)
  const [recentItems, setRecentItems] = useState<RecentContextItem[]>([])
  const [totalCount, setTotalCount] = useState(0)
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
    void loadStatus(scope)
  }, [scope, loadStatus])

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

  function toggleValue(value: string, selected: boolean, current: string[], update: (next: string[]) => void) {
    update(selected ? [...current, value] : current.filter((item) => item !== value))
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

      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Context Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <FilterGroup
            title="Work item types"
            values={CONTEXT_WORK_ITEM_TYPE_OPTIONS}
            selectedValues={workItemTypes}
            onChange={(value, selected) => toggleValue(value, selected, workItemTypes, setWorkItemTypes)}
          />
          <FilterGroup
            title="States"
            values={CONTEXT_STATE_OPTIONS}
            selectedValues={states}
            onChange={(value, selected) => toggleValue(value, selected, states, setStates)}
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
                      <TableHead>
                        <SortHeader label="State" active={sortBy === "state"} direction={sortDirection} onClick={() => changeSort("state")} />
                      </TableHead>
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
                        <TableCell>{item.state ?? "-"}</TableCell>
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

function FilterGroup({
  title,
  values,
  selectedValues,
  onChange,
}: {
  title: string
  values: string[]
  selectedValues: string[]
  onChange: (value: string, selected: boolean) => void
}) {
  return (
    <div>
      <div className="mb-3 text-sm font-semibold text-[#172B4D]">{title}</div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {values.map((value) => {
          const checked = selectedValues.includes(value)
          return (
            <Label key={value} className="flex min-h-10 items-center gap-3 rounded-md border border-[#DCDFE4] bg-white px-3 py-2 text-sm">
              <Checkbox checked={checked} onCheckedChange={(next) => onChange(value, next === true)} />
              <span>{value}</span>
            </Label>
          )
        })}
      </div>
    </div>
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

function formatDate(value?: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}
