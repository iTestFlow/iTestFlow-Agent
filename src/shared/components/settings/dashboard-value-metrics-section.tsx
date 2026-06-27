"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Info, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { OwnerOnlyNotice } from "./owner-only-notice"
import { SectionCard } from "./section-card"

type BaselineMap = Partial<Record<string, number>>

// One-line description of the fully-manual task each baseline stands in for. Keyed
// by workflow type; unknown types simply render without a description.
const WORKFLOW_DESCRIPTIONS: Record<string, string> = {
  requirements_analysis: "Manually analyze a requirement for risks, testability, and gaps.",
  test_case_design: "Manually design the test cases for one work item.",
  test_gap_analysis: "Manually find coverage gaps across requirements and tests.",
  report_bug: "Manually investigate and write up one defect.",
  test_execution_effort: "Manually estimate execution effort for a test set.",
  suite_migration: "Manually migrate one legacy test suite.",
  bulk_task_creation: "Manually create a batch of work items.",
  knowledge_indexing: "Manually catalogue project documents for AI context.",
  business_owner_assistant: "Manually research and answer one stakeholder question.",
}

type ValueMetricsDefaults = {
  workflowTypes: string[]
  workflowLabels: Record<string, string>
  manualBaselineDefaults: Record<string, number>
  reviewBaselineDefaults: Record<string, number>
  perItemReviewTypes: string[]
}

type WorkspaceSettingsResponse = {
  settings: {
    manualBaselineMinutes: BaselineMap | null
    reviewBaselineMinutes: BaselineMap | null
  }
  defaults: ValueMetricsDefaults
}

// Build an explicit-override map: only entries that differ from the deployment
// default are sent, so untouched workflows keep inheriting the default. An empty
// map becomes null (clear all overrides).
function diffFromDefaults(values: Record<string, number>, defaults: Record<string, number>): BaselineMap | null {
  const map: BaselineMap = {}
  for (const [type, value] of Object.entries(values)) {
    if (value !== defaults[type]) map[type] = value
  }
  return Object.keys(map).length ? map : null
}

export function DashboardValueMetricsSection() {
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [defaults, setDefaults] = useState<ValueMetricsDefaults | null>(null)
  const [manual, setManual] = useState<Record<string, number>>({})
  const [review, setReview] = useState<Record<string, number>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/settings", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setForbidden(true)
        return
      }
      if (!response.ok) {
        toast.error("Could not load the value-metrics baselines.")
        return
      }
      const data = (await response.json()) as WorkspaceSettingsResponse
      setDefaults(data.defaults)
      const manualNext: Record<string, number> = {}
      const reviewNext: Record<string, number> = {}
      for (const type of data.defaults.workflowTypes) {
        manualNext[type] = data.settings.manualBaselineMinutes?.[type] ?? data.defaults.manualBaselineDefaults[type]
        reviewNext[type] = data.settings.reviewBaselineMinutes?.[type] ?? data.defaults.reviewBaselineDefaults[type]
      }
      setManual(manualNext)
      setReview(reviewNext)
    } catch {
      toast.error("Could not load the value-metrics baselines.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const perItem = useMemo(() => new Set(defaults?.perItemReviewTypes ?? []), [defaults])

  // Split the workflows into the two review-unit groups, preserving the canonical order.
  const groups = useMemo(() => {
    const types = defaults?.workflowTypes ?? []
    return [
      { key: "per-item", title: "Generative workflows — review per item", types: types.filter((type) => perItem.has(type)) },
      { key: "per-run", title: "Conversational workflows — review per run", types: types.filter((type) => !perItem.has(type)) },
    ].filter((group) => group.types.length > 0)
  }, [defaults, perItem])

  async function save(manualMap: BaselineMap | null, reviewMap: BaselineMap | null) {
    setSaving(true)
    try {
      const response = await fetch("/api/workspace/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manualBaselineMinutes: manualMap, reviewBaselineMinutes: reviewMap }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not save the value-metrics baselines.")
        return
      }
      toast.success("Value-metrics baselines saved.")
    } finally {
      setSaving(false)
    }
  }

  function onSave() {
    if (!defaults) return
    void save(
      diffFromDefaults(manual, defaults.manualBaselineDefaults),
      diffFromDefaults(review, defaults.reviewBaselineDefaults),
    )
  }

  function onReset() {
    if (!defaults) return
    const manualNext: Record<string, number> = {}
    const reviewNext: Record<string, number> = {}
    for (const type of defaults.workflowTypes) {
      manualNext[type] = defaults.manualBaselineDefaults[type]
      reviewNext[type] = defaults.reviewBaselineDefaults[type]
    }
    setManual(manualNext)
    setReview(reviewNext)
    void save(null, null)
  }

  return (
    <SectionCard
      title="Value Metrics Baselines"
      description="Inputs for the dashboard's transparent time-saving estimates. Net (labor) saved = Manual − Review."
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : (
        <div className="space-y-4">
          <Table className="min-w-[34rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Workflow</TableHead>
                <TableHead className="w-40 text-right">
                  <HeaderLabel label="Manual" hint="Time to complete this workflow entirely by hand, per run." />
                </TableHead>
                <TableHead className="w-44 text-right">
                  <HeaderLabel label="Review" hint="Estimated effort to review the AI output. Per generated item for generative workflows; per run otherwise." />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <GroupRows
                  key={group.key}
                  title={group.title}
                  types={group.types}
                  labels={defaults?.workflowLabels ?? {}}
                  perItem={perItem}
                  manual={manual}
                  review={review}
                  manualDefaults={defaults?.manualBaselineDefaults ?? {}}
                  reviewDefaults={defaults?.reviewBaselineDefaults ?? {}}
                  disabled={loading}
                  onManualChange={(type, value) => setManual((current) => ({ ...current, [type]: value }))}
                  onReviewChange={(type, value) => setReview((current) => ({ ...current, [type]: value }))}
                />
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={onReset} disabled={saving || loading}>
              Reset to recommended defaults
            </Button>
            <Button type="button" className="ml-auto" onClick={onSave} disabled={saving || loading}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  )
}

function GroupRows({
  title,
  types,
  labels,
  perItem,
  manual,
  review,
  manualDefaults,
  reviewDefaults,
  disabled,
  onManualChange,
  onReviewChange,
}: {
  title: string
  types: string[]
  labels: Record<string, string>
  perItem: Set<string>
  manual: Record<string, number>
  review: Record<string, number>
  manualDefaults: Record<string, number>
  reviewDefaults: Record<string, number>
  disabled: boolean
  onManualChange: (type: string, value: number) => void
  onReviewChange: (type: string, value: number) => void
}) {
  return (
    <>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={3} className="bg-muted/40 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </TableCell>
      </TableRow>
      {types.map((type) => {
        const isPerItem = perItem.has(type)
        const manualValue = manual[type] ?? 0
        const reviewValue = review[type] ?? 0
        const reviewExceedsManual = !isPerItem && reviewValue > manualValue
        const customized = manualValue !== manualDefaults[type] || reviewValue !== reviewDefaults[type]
        const reviewUnit = isPerItem ? "min/item" : "min/run"
        return (
          <TableRow key={type}>
            <TableCell className="py-2.5 align-top">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{labels[type] ?? type}</span>
                {customized ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="outline" className="cursor-default">Customized</Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      Recommended: {manualDefaults[type]} min · {reviewDefaults[type]} {reviewUnit}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {reviewExceedsManual ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge variant="destructive" className="cursor-default gap-1">
                        <TriangleAlert /> review ≥ manual
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>Review effort meets or exceeds the manual baseline — the AI saves no time for this workflow.</TooltipContent>
                  </Tooltip>
                ) : null}
              </div>
              {WORKFLOW_DESCRIPTIONS[type] ? (
                <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {WORKFLOW_DESCRIPTIONS[type]}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="py-2.5 text-right align-top">
              <BaselineInput
                ariaLabel={`${labels[type] ?? type} manual baseline minutes`}
                unit="min"
                widthClass="w-28"
                value={manualValue}
                disabled={disabled}
                onChange={(value) => onManualChange(type, value)}
              />
            </TableCell>
            <TableCell className="py-2.5 text-right align-top">
              <BaselineInput
                ariaLabel={`${labels[type] ?? type} review baseline ${isPerItem ? "minutes per item" : "minutes per run"}`}
                unit={reviewUnit}
                widthClass="w-36"
                value={reviewValue}
                disabled={disabled}
                onChange={(value) => onReviewChange(type, value)}
              />
            </TableCell>
          </TableRow>
        )
      })}
    </>
  )
}

function HeaderLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <span className="inline-flex items-center justify-end gap-1">
      {label}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={`About ${label}`} className="text-muted-foreground transition-colors hover:text-foreground">
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </span>
  )
}

function BaselineInput({
  ariaLabel,
  unit,
  widthClass,
  value,
  disabled,
  onChange,
}: {
  ariaLabel: string
  unit: string
  widthClass: string
  value: number
  disabled: boolean
  onChange: (value: number) => void
}) {
  return (
    <InputGroup className={`ml-auto h-9 ${widthClass}`}>
      <InputGroupInput
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        aria-label={ariaLabel}
        className="text-right tabular-nums"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const parsed = Math.trunc(Number(event.target.value))
          onChange(Number.isFinite(parsed) && parsed >= 0 ? parsed : 0)
        }}
      />
      <InputGroupAddon align="inline-end" className="text-[11px]">
        {unit}
      </InputGroupAddon>
    </InputGroup>
  )
}
