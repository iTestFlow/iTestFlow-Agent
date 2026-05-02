"use client"

import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContentShell } from "@/components/layout/content-shell"
import { ConfigurationForm } from "@/shared/components/live/configuration-form"

export default function SettingsPage() {
  const [summary, setSummary] = useState<null | {
    configured: boolean
    savedAt?: string
    azureDevOps?: { organizationUrl: string; hasPersonalAccessToken: boolean }
    llm?: { provider: string; model: string; hasApiKey: boolean; temperature: number; maxTokens: number }
  }>(null)

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
      <Alert className="border-[#0C66E4]/20 bg-[#E9F2FF]">
        <AlertTitle>Editable live runtime settings</AlertTitle>
        <AlertDescription className="text-[#44546F]">
          Values on this page load from `/api/settings/runtime` and save back through the same live runtime settings API. Re-enter secrets only when rotating credentials.
        </AlertDescription>
      </Alert>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <ConfigurationForm mode="settings" redirectTo={null} onSaved={refreshSummary} />
        <Card className="qa-card h-fit">
          <CardHeader>
            <CardTitle className="text-base">Current runtime summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-[#44546F]">
            <p>Configured: {summary?.configured ? "Yes" : "No"}</p>
            <p>Saved at: {summary?.savedAt ?? "Not saved"}</p>
            <p>Azure DevOps org: {summary?.azureDevOps?.organizationUrl ?? "Not configured"}</p>
            <p>Azure DevOps PAT saved: {summary?.azureDevOps?.hasPersonalAccessToken ? "Yes" : "No"}</p>
            <p>LLM provider: {summary?.llm?.provider ?? "Not configured"}</p>
            <p>LLM model: {summary?.llm?.model ?? "Not configured"}</p>
            <p>LLM key saved: {summary?.llm?.hasApiKey ? "Yes" : "No"}</p>
          </CardContent>
        </Card>
      </div>
    </ContentShell>
  )
}
