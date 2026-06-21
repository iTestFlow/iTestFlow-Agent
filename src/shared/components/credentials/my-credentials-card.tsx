"use client"

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type CredentialSummary = {
  status: "not_configured" | "configured" | "invalid" | "expired"
  maskedPreview: string | null
  provider?: string | null
  model?: string | null
  lastValidatedAt?: string | null
  isStale?: boolean
}

type CredentialStatusResponse = {
  workspaceId: string
  azurePat: CredentialSummary
  llm: CredentialSummary
}

const LLM_PROVIDERS = ["openai", "gemini", "anthropic"] as const

function StatusBadge({ status }: { status: CredentialSummary["status"] }) {
  const label = status === "not_configured" ? "Not configured" : status.charAt(0).toUpperCase() + status.slice(1)
  const variant = status === "configured" ? "default" : status === "not_configured" ? "secondary" : "destructive"
  return <Badge variant={variant}>{label}</Badge>
}

function lastValidatedLabel(value?: string | null): string | null {
  if (!value) return null
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  const days = Math.floor((Date.now() - parsed) / (24 * 60 * 60 * 1000))
  if (days <= 0) return "Last validated today"
  if (days === 1) return "Last validated yesterday"
  return `Last validated ${days} days ago`
}

/** A re-validation warning for a credential, or null when it's healthy. */
function credentialWarning(label: string, summary?: CredentialSummary): string | null {
  if (!summary) return null
  if (summary.status === "expired" || summary.status === "invalid") {
    return `Your ${label} was rejected by the provider. Re-enter it below to restore access.`
  }
  if (summary.isStale) {
    return `Your ${label} hasn't been validated in a while. Re-enter it to confirm it still works.`
  }
  return null
}

export function MyCredentialsCard() {
  const [status, setStatus] = useState<CredentialStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [unauthenticated, setUnauthenticated] = useState(false)
  const [saving, setSaving] = useState(false)

  const [azurePat, setAzurePat] = useState("")
  const [provider, setProvider] = useState<(typeof LLM_PROVIDERS)[number]>("openai")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/settings/credentials", { cache: "no-store" })
      if (response.status === 401) {
        setUnauthenticated(true)
        return
      }
      setUnauthenticated(false)
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        toast.error(data.error ?? "Could not load credentials.")
        return
      }
      setStatus((await response.json()) as CredentialStatusResponse)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSave(event: React.FormEvent) {
    event.preventDefault()
    const body: { azurePat?: string; llm?: { provider: string; model: string; apiKey: string } } = {}
    if (azurePat.trim()) body.azurePat = azurePat.trim()
    if (apiKey.trim() || model.trim()) {
      if (!apiKey.trim() || !model.trim()) {
        toast.error("Enter both an LLM model and API key to update LLM credentials.")
        return
      }
      body.llm = { provider, model: model.trim(), apiKey: apiKey.trim() }
    }
    if (!body.azurePat && !body.llm) {
      toast.error("Enter an Azure PAT and/or LLM credentials to update.")
      return
    }

    setSaving(true)
    try {
      const response = await fetch("/api/settings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const data = (await response.json().catch(() => ({}))) as CredentialStatusResponse & { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not save credentials.")
        return
      }
      toast.success("Credentials updated.")
      setAzurePat("")
      setApiKey("")
      setStatus(data)
      window.dispatchEvent(new CustomEvent("itestflow:credentials-changed"))
    } finally {
      setSaving(false)
    }
  }

  if (unauthenticated) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>My Credentials</CardTitle>
          <CardDescription>Sign in to manage your private Azure DevOps and LLM credentials.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const warnings = [
    credentialWarning("Azure DevOps PAT", status?.azurePat),
    credentialWarning("LLM API key", status?.llm),
  ].filter((warning): warning is string => warning !== null)
  const azurePatValidated = lastValidatedLabel(status?.azurePat.lastValidatedAt)
  const llmValidated = lastValidatedLabel(status?.llm.lastValidatedAt)

  return (
    <Card>
      <CardHeader>
        <CardTitle>My Credentials</CardTitle>
        <CardDescription>
          Private to your account. Secrets are encrypted server-side — only a masked preview and status are shown
          here, never the raw values.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {!loading && warnings.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle className="text-sm">Action needed</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Azure DevOps PAT</span>
              <StatusBadge status={status?.azurePat.status ?? "not_configured"} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading ? "Loading…" : status?.azurePat.maskedPreview ?? "No token stored."}
            </p>
            {!loading && azurePatValidated ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{azurePatValidated}</p>
            ) : null}
          </div>
          <div className="rounded-md border p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">LLM API key</span>
              <StatusBadge status={status?.llm.status ?? "not_configured"} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : status?.llm.maskedPreview
                  ? `${status.llm.provider ?? ""} ${status.llm.model ?? ""} · ${status.llm.maskedPreview}`.trim()
                  : "No key stored."}
            </p>
            {!loading && llmValidated ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{llmValidated}</p>
            ) : null}
          </div>
        </div>

        <form className="space-y-4" onSubmit={onSave}>
          <div className="space-y-2">
            <Label htmlFor="azurePat">Update Azure DevOps PAT</Label>
            <Input
              id="azurePat"
              type="password"
              placeholder="Leave blank to keep current token"
              value={azurePat}
              onChange={(event) => setAzurePat(event.target.value)}
              autoComplete="off"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>LLM provider</Label>
              <Select value={provider} onValueChange={(value) => setProvider(value as typeof provider)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <Input id="model" placeholder="e.g. gpt-4o" value={model} onChange={(event) => setModel(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="apiKey">LLM API key</Label>
              <Input
                id="apiKey"
                type="password"
                placeholder="Leave blank to keep current key"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                autoComplete="off"
              />
            </div>
          </div>

          <Button type="submit" disabled={saving || loading}>
            {saving ? "Saving…" : "Save credentials"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
