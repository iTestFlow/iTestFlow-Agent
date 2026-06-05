"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { Command as CommandPrimitive } from "cmdk"
import { Check, Loader2 } from "lucide-react"

import { Command, CommandInput, CommandList } from "@/components/ui/command"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { apiErrorMessage } from "@/shared/validators/api-validation-errors"

export type ModelOption = {
  id: string
  displayName: string
  source: string
}

/**
 * Fetches the live model list for an LLM provider from `/api/settings/llm-models`.
 *
 * The caller supplies the request body so each surface can decide whether to send the
 * typed (possibly unsaved) credentials or rely on the saved provider settings. `load`
 * returns the fetched models so callers can react (e.g. auto-select a default); it
 * resolves to `undefined` when a fetch is already in flight.
 */
export function useProviderModels() {
  const [models, setModels] = useState<ModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Monotonic request id. Each load() claims the next id; a response only commits its
  // result if it still owns the latest id, so a slow response can't overwrite the picker
  // after the inputs changed (provider/key/base URL) or after reset() invalidated it.
  const requestRef = useRef(0)

  const load = useCallback(async (body: Record<string, unknown>) => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/settings/llm-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = await response.json()
      if (requestId !== requestRef.current) return undefined
      if (!response.ok) throw new Error(apiErrorMessage(json, "Could not fetch provider models."))

      const fetched = (json.models ?? []) as ModelOption[]
      setModels(fetched)
      setError(fetched.length ? null : "No models were returned from the selected provider API.")
      return fetched
    } catch (err) {
      if (requestId !== requestRef.current) return undefined
      setModels([])
      setError(err instanceof Error ? err.message : "Could not fetch provider models.")
      return [] as ModelOption[]
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    requestRef.current += 1
    setModels([])
    setError(null)
    setLoading(false)
  }, [])

  return { models, loading, error, load, reset }
}

/**
 * Searchable list of provider models built on the shared `Command` primitive (substring
 * filtering, keyboard navigation, accessible listbox semantics). Container-agnostic: render
 * it inside a popover, an inline dropdown, etc. Search state is owned internally and resets
 * whenever the picker unmounts (i.e. when its container closes).
 */
export function ModelPicker({
  models,
  loading,
  error,
  providerLabel,
  currentModel,
  savingModelId = null,
  emptyHint = "No models loaded yet.",
  autoFocus = false,
  className,
  onRetry,
  onSelect,
}: {
  models: ModelOption[]
  loading: boolean
  error: string | null
  providerLabel: string
  currentModel: string
  savingModelId?: string | null
  emptyHint?: string
  autoFocus?: boolean
  className?: string
  onRetry: () => void
  onSelect: (modelId: string) => void
}) {
  const [search, setSearch] = useState("")

  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return models
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query),
    )
  }, [search, models])

  return (
    <Command shouldFilter={false} className={cn("bg-transparent", className)}>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search models..."
        autoFocus={autoFocus}
      />
      <CommandList className="max-h-80">
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            Loading {providerLabel} models...
          </div>
        ) : error ? (
          <div className="space-y-3 px-3 py-3">
            <div className="text-sm text-destructive">{error}</div>
            <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onRetry}>
              Retry Loading Models
            </Button>
          </div>
        ) : filteredModels.length ? (
          filteredModels.map((model) => {
            const active = model.id === currentModel
            const saving = savingModelId === model.id

            return (
              <CommandPrimitive.Item
                key={model.id}
                value={model.id}
                disabled={Boolean(savingModelId)}
                onSelect={() => onSelect(model.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none",
                  "data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground",
                  "data-[disabled=true]:pointer-events-none",
                  active && "bg-accent text-primary",
                  savingModelId && !saving && "opacity-60",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{model.displayName}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">{model.id}</span>
                </span>
                {saving ? <Loader2 className="size-4 shrink-0 animate-spin text-primary" /> : null}
                {active && !saving ? <Check className="size-4 shrink-0 text-primary" /> : null}
              </CommandPrimitive.Item>
            )
          })
        ) : (
          <div className="px-3 py-3 text-sm text-muted-foreground">
            {search ? "No models match your search." : emptyHint}
          </div>
        )}
      </CommandList>
    </Command>
  )
}
