"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { ContextFilterSelector } from "@/components/domain/context-filter-selector"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DEFAULT_CONTEXT_STATES, DEFAULT_CONTEXT_WORK_ITEM_TYPES } from "@/lib/project-context-defaults"
import { apiErrorMessage } from "@/shared/lib/api-error-message"
import {
  buildDailyCron,
  buildMonthlyCron,
  buildWeeklyCron,
  describeCron,
  parseSchedule,
  parseTimeInputValue,
  toTimeInputValue,
  WEEKDAY_NAMES,
} from "@/shared/lib/cron-schedule"
import { useActiveProject } from "@/shared/lib/use-active-project"
import { useProjectWorkItemMetadata } from "@/shared/lib/use-project-work-item-metadata"
import { isValidCronExpression } from "@/modules/settings/cron-expression"
import { OwnerOnlyNotice } from "./owner-only-notice"
import { SectionCard, StatusBadge } from "./section-card"

type ScheduleResponse = {
  workspaceId: string
  schedule: {
    cronExpression: string
    enabled: boolean
    nextRunAt: string | null
    lastEnqueuedAt: string | null
    workItemTypes: string[]
    states: string[]
  } | null
}

type Frequency = "daily" | "weekly" | "monthly" | "custom"

const DEFAULT_TIME = "02:00"

export function AutomationSection() {
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [enabled, setEnabled] = useState(true)
  const [frequency, setFrequency] = useState<Frequency>("daily")
  const [time, setTime] = useState(DEFAULT_TIME)
  const [dayOfWeek, setDayOfWeek] = useState(1) // Monday
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [customCron, setCustomCron] = useState("0 2 * * *")
  const [nextRunAt, setNextRunAt] = useState<string | null>(null)
  const [lastEnqueuedAt, setLastEnqueuedAt] = useState<string | null>(null)
  const [hasSaved, setHasSaved] = useState(false)
  const [workItemTypes, setWorkItemTypes] = useState<string[]>(DEFAULT_CONTEXT_WORK_ITEM_TYPES)
  const [states, setStates] = useState<string[]>(DEFAULT_CONTEXT_STATES)

  const activeProject = useActiveProject()
  const activeScope = activeProject ?? null
  const {
    metadata: workItemMetadata,
    loading: metadataLoading,
    error: metadataError,
    retry: retryMetadata,
  } = useProjectWorkItemMetadata(activeScope)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/sync-schedule", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setForbidden(true)
        return
      }
      if (!response.ok) {
        toast.error("Could not load the sync schedule.")
        return
      }
      const data = (await response.json()) as ScheduleResponse
      if (data.schedule) {
        setHasSaved(true)
        setEnabled(data.schedule.enabled)
        setNextRunAt(data.schedule.nextRunAt)
        setLastEnqueuedAt(data.schedule.lastEnqueuedAt)
        setWorkItemTypes(data.schedule.workItemTypes.length ? data.schedule.workItemTypes : DEFAULT_CONTEXT_WORK_ITEM_TYPES)
        setStates(data.schedule.states.length ? data.schedule.states : DEFAULT_CONTEXT_STATES)
        const parsed = parseSchedule(data.schedule.cronExpression)
        if (parsed) {
          setFrequency(parsed.mode)
          setTime(toTimeInputValue({ hour: parsed.hour, minute: parsed.minute }))
          if (parsed.mode === "weekly") setDayOfWeek(parsed.dayOfWeek)
          if (parsed.mode === "monthly") setDayOfMonth(parsed.dayOfMonth)
        } else {
          setFrequency("custom")
          setCustomCron(data.schedule.cronExpression)
        }
      }
    } catch {
      toast.error("Could not load the sync schedule.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const cronExpression = useMemo(() => {
    if (frequency === "custom") return customCron.trim()
    const parsedTime = parseTimeInputValue(time) ?? { hour: 2, minute: 0 }
    if (frequency === "weekly") return buildWeeklyCron(dayOfWeek, parsedTime.hour, parsedTime.minute)
    if (frequency === "monthly") return buildMonthlyCron(dayOfMonth, parsedTime.hour, parsedTime.minute)
    return buildDailyCron(parsedTime.hour, parsedTime.minute)
  }, [frequency, time, dayOfWeek, dayOfMonth, customCron])

  const cronValid = isValidCronExpression(cronExpression)
  const canSave = cronValid && workItemTypes.length > 0 && states.length > 0

  const workItemTypeOptions = useMemo(
    () => uniqueStrings([...(workItemMetadata?.workItemTypes ?? []), ...DEFAULT_CONTEXT_WORK_ITEM_TYPES, ...workItemTypes]),
    [workItemMetadata?.workItemTypes, workItemTypes],
  )
  const stateOptions = useMemo(
    () => uniqueStrings([...(workItemMetadata?.states ?? []), ...DEFAULT_CONTEXT_STATES, ...states]),
    [workItemMetadata?.states, states],
  )

  async function onSave() {
    if (!cronValid) {
      toast.error("Enter a valid 5-field cron expression.")
      return
    }
    if (!workItemTypes.length || !states.length) {
      toast.error("Select at least one work item type and state.")
      return
    }
    setSaving(true)
    try {
      const response = await fetch("/api/workspace/sync-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpression, enabled, workItemTypes, states }),
      })
      const data = (await response.json().catch(() => ({}))) as ScheduleResponse & { error?: string }
      if (!response.ok) {
        toast.error(apiErrorMessage(data, "Could not save the schedule."))
        return
      }
      toast.success("Sync schedule saved.")
      setHasSaved(true)
      setNextRunAt(data.schedule?.nextRunAt ?? null)
      setLastEnqueuedAt(data.schedule?.lastEnqueuedAt ?? null)
      window.dispatchEvent(new CustomEvent("itestflow:sync-schedule-changed"))
    } finally {
      setSaving(false)
    }
  }

  async function onRemove() {
    setSaving(true)
    try {
      const response = await fetch("/api/workspace/sync-schedule", { method: "DELETE" })
      if (!response.ok) {
        toast.error("Could not remove the schedule.")
        return
      }
      toast.success("Sync schedule removed.")
      setHasSaved(false)
      setNextRunAt(null)
      setLastEnqueuedAt(null)
      setEnabled(true)
      setFrequency("daily")
      setTime(DEFAULT_TIME)
      setWorkItemTypes(DEFAULT_CONTEXT_WORK_ITEM_TYPES)
      setStates(DEFAULT_CONTEXT_STATES)
      window.dispatchEvent(new CustomEvent("itestflow:sync-schedule-changed"))
    } finally {
      setSaving(false)
    }
  }

  const badge = !hasSaved
    ? { tone: "muted" as const, label: "No schedule" }
    : enabled
      ? { tone: "success" as const, label: "Enabled" }
      : { tone: "warning" as const, label: "Paused" }

  return (
    <SectionCard
      title="Scheduled Knowledge Sync"
      description="How often the worker re-syncs this workspace's Azure DevOps context using the workspace sync credential. Times are in the server's local timezone. With no schedule, the workspace is only synced when someone clicks “Sync now”."
      action={forbidden ? undefined : <StatusBadge tone={badge.tone} label={badge.label} />}
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">Enable scheduled sync</div>
              <p className="text-xs text-muted-foreground">Turn off to pause without losing the schedule.</p>
            </div>
            <Checkbox checked={enabled} onCheckedChange={(checked) => setEnabled(checked === true)} disabled={loading} aria-label="Enable scheduled sync" />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <ContextFilterSelector
              title="Work item types"
              description="Scheduled sync includes Azure DevOps work items with these types."
              options={workItemTypeOptions}
              selectedValues={workItemTypes}
              loading={metadataLoading && Boolean(activeScope)}
              error={activeScope ? metadataError : null}
              disabled={!enabled}
              searchPlaceholder="Search work item types"
              emptyMessage="No work item types were returned for this project."
              onRetry={retryMetadata}
              onChange={setWorkItemTypes}
            />
            <ContextFilterSelector
              title="States"
              description="Scheduled sync includes source work items in these states."
              options={stateOptions}
              selectedValues={states}
              loading={metadataLoading && Boolean(activeScope)}
              error={activeScope ? metadataError : null}
              disabled={!enabled}
              searchPlaceholder="Search states"
              emptyMessage="No work item states were returned for this project."
              onRetry={retryMetadata}
              onChange={setStates}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Frequency</Label>
              <Select value={frequency} onValueChange={(value) => setFrequency(value as Frequency)} disabled={!enabled}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="custom">Custom (cron)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {frequency === "weekly" ? (
              <div className="space-y-2">
                <Label>Day of week</Label>
                <Select value={String(dayOfWeek)} onValueChange={(value) => setDayOfWeek(Number(value))} disabled={!enabled}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_NAMES.map((name, index) => (
                      <SelectItem key={name} value={String(index)}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {frequency === "monthly" ? (
              <div className="space-y-2">
                <Label>Day of month</Label>
                <Select value={String(dayOfMonth)} onValueChange={(value) => setDayOfMonth(Number(value))} disabled={!enabled}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
                      <SelectItem key={day} value={String(day)}>
                        {day}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {frequency === "custom" ? (
              <div className="space-y-2">
                <Label htmlFor="customCron">Cron expression</Label>
                <Input
                  id="customCron"
                  value={customCron}
                  onChange={(event) => setCustomCron(event.target.value)}
                  placeholder="0 2 * * *"
                  disabled={!enabled}
                />
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="time">Time</Label>
                <Input id="time" type="time" value={time} onChange={(event) => setTime(event.target.value)} disabled={!enabled} />
              </div>
            )}
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className={cronValid ? "text-foreground" : "text-destructive"}>
              {cronValid ? describeCron(cronExpression) : "Invalid cron expression."}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Sync filters: {workItemTypes.length} work item {workItemTypes.length === 1 ? "type" : "types"}, {states.length} {states.length === 1 ? "state" : "states"}.
            </p>
            {enabled && nextRunAt ? (
              <p className="mt-1 text-xs text-muted-foreground">Next run: {new Date(nextRunAt).toLocaleString()}</p>
            ) : null}
            {lastEnqueuedAt ? (
              <p className="mt-0.5 text-xs text-muted-foreground">Last enqueued: {new Date(lastEnqueuedAt).toLocaleString()}</p>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" onClick={() => void onSave()} disabled={saving || loading || !canSave}>
              {saving ? (
                <>
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save schedule"
              )}
            </Button>
            {hasSaved ? (
              <Button type="button" variant="ghost" className="text-destructive" onClick={() => void onRemove()} disabled={saving}>
                Remove schedule
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </SectionCard>
  )
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) continue
    const key = trimmed.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(trimmed)
  }
  return unique
}
