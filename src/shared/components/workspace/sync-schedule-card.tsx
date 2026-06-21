"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { isValidCronExpression } from "@/modules/settings/cron-expression"

type ScheduleResponse = {
  workspaceId: string
  schedule: { cronExpression: string; enabled: boolean; nextRunAt: string | null; lastEnqueuedAt: string | null } | null
}

type Frequency = "daily" | "weekly" | "monthly" | "custom"

const DEFAULT_TIME = "02:00"

export function SyncScheduleCard() {
  const [hidden, setHidden] = useState(false)
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

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/sync-schedule", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setHidden(true)
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

  // The cron string the current form represents (the single source of truth on save).
  const cronExpression = useMemo(() => {
    if (frequency === "custom") return customCron.trim()
    const parsedTime = parseTimeInputValue(time) ?? { hour: 2, minute: 0 }
    if (frequency === "weekly") return buildWeeklyCron(dayOfWeek, parsedTime.hour, parsedTime.minute)
    if (frequency === "monthly") return buildMonthlyCron(dayOfMonth, parsedTime.hour, parsedTime.minute)
    return buildDailyCron(parsedTime.hour, parsedTime.minute)
  }, [frequency, time, dayOfWeek, dayOfMonth, customCron])

  const cronValid = isValidCronExpression(cronExpression)

  if (hidden) return null

  async function onSave() {
    if (!cronValid) {
      toast.error("Enter a valid 5-field cron expression.")
      return
    }
    setSaving(true)
    try {
      const response = await fetch("/api/workspace/sync-schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cronExpression, enabled }),
      })
      const data = (await response.json().catch(() => ({}))) as ScheduleResponse & { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not save the schedule.")
        return
      }
      toast.success("Sync schedule saved.")
      setHasSaved(true)
      setNextRunAt(data.schedule?.nextRunAt ?? null)
      setLastEnqueuedAt(data.schedule?.lastEnqueuedAt ?? null)
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
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scheduled sync</CardTitle>
        <CardDescription>
          How often the worker re-syncs this workspace&apos;s Azure DevOps context using the workspace sync
          credential. Times are in the server&apos;s local timezone. With no schedule, the workspace is only
          synced when someone clicks &ldquo;Sync now&rdquo;.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="text-sm font-medium">Enable scheduled sync</div>
            <p className="text-xs text-muted-foreground">Turn off to pause without losing the schedule.</p>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} disabled={loading} aria-label="Enable scheduled sync" />
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
          {enabled && nextRunAt ? (
            <p className="mt-1 text-xs text-muted-foreground">Next run: {new Date(nextRunAt).toLocaleString()}</p>
          ) : null}
          {lastEnqueuedAt ? (
            <p className="mt-0.5 text-xs text-muted-foreground">Last enqueued: {new Date(lastEnqueuedAt).toLocaleString()}</p>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => void onSave()} disabled={saving || loading || !cronValid}>
            {saving ? "Saving…" : "Save schedule"}
          </Button>
          {hasSaved ? (
            <Button type="button" variant="ghost" className="text-destructive" onClick={() => void onRemove()} disabled={saving}>
              Remove schedule
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
