"use client"

import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContentShell } from "@/components/layout/content-shell"
import { ConfigurationForm } from "@/shared/components/live/configuration-form"

type LatestAutoUpdateRunSummary = {
  status: string
  startedAt: string
  completedAt?: string | null
  cronTimezone?: string
  errorDetails?: string | null
  workItemTypes?: string[]
  states?: string[]
  contextSyncMode?: string | null
  contextIndexedWorkItemCount?: number
  contextIndexedChunkCount?: number
  contextCreatedCount?: number
  contextUpdatedCount?: number
  contextUnchangedCount?: number
  contextInactiveCount?: number
  contextSkippedEmptyCount?: number
  knowledgeSourceWorkItemCount?: number
  knowledgeCompileMode?: string | null
  knowledgeCompileStatus?: string
  knowledgeCompileSkippedReason?: string | null
}

type RuntimeSummary = {
  configured: boolean
  savedAt?: string
  azureDevOps?: { organizationUrl: string; hasPersonalAccessToken: boolean }
  llm?: { provider: string; model: string; hasApiKey: boolean; temperature: number; maxTokens: number; retryAttempts: number }
  context?: {
    retrievalTopK: number
    autoUpdate?: {
      enabled: boolean
      cronExpression: string
      projectScope?: { azureProjectName: string } | null
      workItemTypes?: string[]
      states?: string[]
      latestRun?: LatestAutoUpdateRunSummary | null
    }
  }
}

export default function SettingsPage() {
  const [summary, setSummary] = useState<null | RuntimeSummary>(null)

  function refreshSummary() {
    fetch("/api/settings/runtime", { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => setSummary(json))
      .catch(() => setSummary({ configured: false }))
  }

  useEffect(() => {
    refreshSummary()
  }, [])

  return (
    <ContentShell
      title="Settings"
      description="Configure local providers, active project, storage, prompts, scoring, and system behavior."
    >
      <Alert className="border-primary/20 bg-primary/10">
        <AlertTitle>Editable live runtime settings</AlertTitle>
        <AlertDescription className="text-muted-foreground">
          Values on this page load from `/api/settings/runtime` and save back through the same live runtime settings API. Re-enter secrets only when rotating credentials.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ConfigurationForm mode="settings" redirectTo={null} onSaved={refreshSummary} />
        <Card className="qa-card h-fit">
          <CardHeader>
            <CardTitle className="text-base">Current runtime summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>Configured: {summary?.configured ? "Yes" : "No"}</p>
            <p>Saved at: {summary?.savedAt ?? "Not saved"}</p>
            <p>Azure DevOps org: {summary?.azureDevOps?.organizationUrl ?? "Not configured"}</p>
            <p>Azure DevOps PAT saved: {summary?.azureDevOps?.hasPersonalAccessToken ? "Yes" : "No"}</p>
            <p>LLM provider: {summary?.llm?.provider ?? "Not configured"}</p>
            <p>LLM model: {summary?.llm?.model ?? "Not configured"}</p>
            <p>LLM key saved: {summary?.llm?.hasApiKey ? "Yes" : "No"}</p>
            <p>LLM retry attempts: {summary?.llm?.retryAttempts ?? 1}</p>
            <p>Context retrieval count: {summary?.context?.retrievalTopK ?? 8}</p>
            <p>Auto update: {summary?.context?.autoUpdate?.enabled ? "Enabled" : "Disabled"}</p>
            <p>Auto update cron: {summary?.context?.autoUpdate?.cronExpression ?? "Not configured"}</p>
            <p>Auto update project: {summary?.context?.autoUpdate?.projectScope?.azureProjectName ?? "Not configured"}</p>
            <p>Auto update types: {formatList(summary?.context?.autoUpdate?.workItemTypes)}</p>
            <p>Auto update states: {formatList(summary?.context?.autoUpdate?.states)}</p>
            <div className="border-t border-border pt-3">
              <p className="font-medium text-foreground">Latest auto update run</p>
              <p>Status: {summary?.context?.autoUpdate?.latestRun?.status ?? "No runs yet"}</p>
              <p>Started: {formatDate(summary?.context?.autoUpdate?.latestRun?.startedAt)}</p>
              <p>Completed: {formatDate(summary?.context?.autoUpdate?.latestRun?.completedAt)}</p>
              <p>Schedule timezone: {summary?.context?.autoUpdate?.latestRun?.cronTimezone ?? "server local time"}</p>
              <p>Context sync mode: {summary?.context?.autoUpdate?.latestRun?.contextSyncMode ?? "-"}</p>
              <p>Indexed work items: {summary?.context?.autoUpdate?.latestRun?.contextIndexedWorkItemCount ?? 0}</p>
              <p>Indexed chunks: {summary?.context?.autoUpdate?.latestRun?.contextIndexedChunkCount ?? 0}</p>
              <p>Context changes: {formatContextChanges(summary?.context?.autoUpdate?.latestRun)}</p>
              <p>Skipped empty items: {summary?.context?.autoUpdate?.latestRun?.contextSkippedEmptyCount ?? 0}</p>
              <p>Knowledge source items: {summary?.context?.autoUpdate?.latestRun?.knowledgeSourceWorkItemCount ?? 0}</p>
              <p>Knowledge compile: {formatKnowledgeCompile(summary?.context?.autoUpdate?.latestRun)}</p>
              <p>Run types: {formatList(summary?.context?.autoUpdate?.latestRun?.workItemTypes)}</p>
              <p>Run states: {formatList(summary?.context?.autoUpdate?.latestRun?.states)}</p>
              {summary?.context?.autoUpdate?.latestRun?.errorDetails ? (
                <p className="text-destructive">Error: {summary.context.autoUpdate.latestRun.errorDetails}</p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      </div>
    </ContentShell>
  )
}

function formatDate(value?: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function formatList(values?: string[]) {
  return values?.length ? values.join(", ") : "-"
}

function formatContextChanges(run?: LatestAutoUpdateRunSummary | null) {
  if (!run) return "-"
  return `${run.contextCreatedCount ?? 0} created, ${run.contextUpdatedCount ?? 0} updated, ${run.contextUnchangedCount ?? 0} unchanged, ${run.contextInactiveCount ?? 0} inactive`
}

function formatKnowledgeCompile(run?: LatestAutoUpdateRunSummary | null) {
  if (!run) return "-"
  const status = run.knowledgeCompileStatus ?? "pending"
  const mode = run.knowledgeCompileMode ? ` (${run.knowledgeCompileMode})` : ""
  return run.knowledgeCompileSkippedReason
    ? `${status}${mode}: ${run.knowledgeCompileSkippedReason}`
    : `${status}${mode}`
}
