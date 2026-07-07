"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { apiErrorMessage } from "@/shared/lib/api-error-message"
import { OwnerOnlyNotice } from "./owner-only-notice"
import { Field, SectionCard } from "./section-card"

type WorkspaceSettingsResponse = {
  settings: { retrievalTopK: number | null; maxOutputTokenCap: number | null }
  defaults: { retrievalTopKDefault: number; topKMin: number; topKMax: number }
}

const PRESETS: { label: string; value: number }[] = [
  { label: "Focused", value: 5 },
  { label: "Recommended", value: 8 },
  { label: "Broad", value: 12 },
]

export function KnowledgeContextSection() {
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [topK, setTopK] = useState<number>(8)
  const [defaults, setDefaults] = useState<WorkspaceSettingsResponse["defaults"] | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/workspace/settings", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setForbidden(true)
        return
      }
      if (!response.ok) {
        toast.error("Could not load the retrieval settings.")
        return
      }
      const data = (await response.json()) as WorkspaceSettingsResponse
      setDefaults(data.defaults)
      setTopK(data.settings.retrievalTopK ?? data.defaults.retrievalTopKDefault)
    } catch {
      toast.error("Could not load the retrieval settings.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function onSave() {
    setSaving(true)
    try {
      const response = await fetch("/api/workspace/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retrievalTopK: topK }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(apiErrorMessage(data, "Could not save the retrieval settings."))
        return
      }
      toast.success("Retrieval settings saved.")
    } finally {
      setSaving(false)
    }
  }

  const min = defaults?.topKMin ?? 1
  const max = defaults?.topKMax ?? 25

  return (
    <SectionCard
      title="Project Context Retrieval"
      description="How many related work items the AI pulls in as context for generations. Shared by everyone in this workspace."
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : (
        <Field
          label="Related work items to retrieve"
          htmlFor="retrieval-top-k"
          description="Higher values give the AI more context but may increase token usage. Pinned and linked items are always added on top."
        >
          <div className="flex flex-wrap items-center gap-2">
            {PRESETS.map((preset) => (
              <Button
                key={preset.value}
                type="button"
                size="sm"
                variant={topK === preset.value ? "default" : "outline"}
                aria-pressed={topK === preset.value}
                onClick={() => setTopK(preset.value)}
                disabled={loading}
              >
                {preset.label}: {preset.value}
              </Button>
            ))}
            <Input
              id="retrieval-top-k"
              aria-label="Related work items to retrieve"
              type="number"
              min={min}
              max={max}
              step={1}
              className="h-8 w-24 border-input bg-card text-foreground"
              value={topK}
              placeholder="8"
              onChange={(event) => {
                const raw = event.target.value
                const parsed = Math.trunc(Number(raw))
                if (Number.isFinite(parsed) && parsed > 0) setTopK(Math.min(max, Math.max(min, parsed)))
              }}
              disabled={loading}
            />
            <Button type="button" className="ml-auto" onClick={() => void onSave()} disabled={saving || loading}>
              {saving ? (
                <>
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        </Field>
      )}
    </SectionCard>
  )
}
