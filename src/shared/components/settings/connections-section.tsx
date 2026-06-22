"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, SecretField, SectionCard, StatusBadge, type StatusTone } from "./section-card"

type CredentialSummary = {
  status: "not_configured" | "configured" | "invalid" | "expired"
  maskedPreview: string | null
  lastValidatedAt?: string | null
  isStale?: boolean
}

type CredentialStatusResponse = {
  workspaceId: string
  azureOrgUrl?: string | null
  azurePat: CredentialSummary
  llm: CredentialSummary
}

/** Maps a credential status (+ staleness) to a header badge tone and label. */
export function credentialBadge(summary?: CredentialSummary): { tone: StatusTone; label: string } {
  if (!summary || summary.status === "not_configured") return { tone: "muted", label: "Not configured" }
  if (summary.status === "invalid") return { tone: "destructive", label: "Invalid" }
  if (summary.status === "expired") return { tone: "destructive", label: "Expired" }
  if (summary.isStale) return { tone: "warning", label: "Re-validate" }
  return { tone: "success", label: "Configured" }
}

export function ConnectionsSection() {
  const [status, setStatus] = useState<CredentialStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [azurePat, setAzurePat] = useState("")

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/settings/credentials", { cache: "no-store" })
      if (!response.ok) {
        if (response.status !== 401) toast.error("Could not load your Azure DevOps connection.")
        return
      }
      setStatus((await response.json()) as CredentialStatusResponse)
    } catch {
      toast.error("Could not load your Azure DevOps connection.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSave() {
    if (!azurePat.trim()) {
      toast.error("Enter your Azure DevOps PAT to update it.")
      return
    }
    setSaving(true)
    try {
      const response = await fetch("/api/settings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ azurePat: azurePat.trim() }),
      })
      const data = (await response.json().catch(() => ({}))) as CredentialStatusResponse & { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not save your PAT.")
        return
      }
      toast.success("Azure DevOps PAT updated.")
      setAzurePat("")
      setStatus(data)
      window.dispatchEvent(new CustomEvent("itestflow:credentials-changed"))
    } finally {
      setSaving(false)
    }
  }

  const badge = credentialBadge(status?.azurePat)
  const hasSavedPat = (status?.azurePat.status ?? "not_configured") !== "not_configured"

  return (
    <SectionCard
      title="Azure DevOps Connection"
      description="Your personal access token authenticates your own Azure DevOps actions. It is encrypted server-side — only a masked preview is shown here, never the raw value."
      action={<StatusBadge tone={badge.tone} label={badge.label} />}
    >
      <Field
        label="Azure DevOps Organization"
        htmlFor="azure-org-url"
        description="Set for this workspace at provisioning time. Sign in to a different organization to switch."
      >
        <Input
          id="azure-org-url"
          className="h-11 border-input bg-muted/40 text-muted-foreground"
          value={loading ? "Loading…" : status?.azureOrgUrl ?? "—"}
          readOnly
          disabled
        />
      </Field>

      <SecretField
        id="azure-pat"
        label="Azure DevOps Personal Access Token (PAT)"
        value={azurePat}
        onChange={setAzurePat}
        placeholder="Enter Azure DevOps PAT"
        hasSaved={hasSavedPat}
        description="Use a PAT with Work Items (Read & Write) and Test Management (Read & Write) scopes. Leave empty to keep the saved token; re-enter it only when rotating."
      />

      <Button type="button" onClick={() => void onSave()} disabled={saving || loading || !azurePat.trim()}>
        {saving ? "Saving…" : "Save PAT"}
      </Button>
    </SectionCard>
  )
}
