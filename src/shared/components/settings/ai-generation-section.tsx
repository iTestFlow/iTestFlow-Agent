"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { SearchableCombobox } from "@/components/ui/searchable-combobox"
import { OwnerOnlyNotice } from "./owner-only-notice"
import {
  Field,
  SecretField,
  SectionCard,
  StatusBadge,
  defaultBaseUrlPlaceholder,
  type Provider,
} from "./section-card"
import { credentialBadge } from "./connections-section"

type CredentialSummary = {
  status: "not_configured" | "configured" | "invalid" | "expired"
  maskedPreview: string | null
  provider?: string | null
  model?: string | null
  isStale?: boolean
}

type CredentialStatusResponse = {
  workspaceId: string
  azurePat: CredentialSummary
  llm: CredentialSummary
}

type ModelOption = { id: string; displayName: string }

const PROVIDERS: Provider[] = ["openai", "gemini", "anthropic"]

export function AiGenerationSection() {
  return (
    <div className="space-y-4">
      <AiProviderCard />
      <OutputCapCard />
    </div>
  )
}

/** Per-user LLM provider / key / model / base URL. */
function AiProviderCard() {
  const [status, setStatus] = useState<CredentialStatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [provider, setProvider] = useState<Provider>("openai")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")
  const [baseUrl, setBaseUrl] = useState("")

  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsFetched, setModelsFetched] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch("/api/settings/credentials", { cache: "no-store" })
      if (!response.ok) {
        if (response.status !== 401) toast.error("Could not load your AI provider settings.")
        return
      }
      const data = (await response.json()) as CredentialStatusResponse
      setStatus(data)
      if (data.llm.provider && PROVIDERS.includes(data.llm.provider as Provider)) {
        setProvider(data.llm.provider as Provider)
      }
      if (data.llm.model) setModel(data.llm.model)
    } catch {
      toast.error("Could not load your AI provider settings.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const onChange = () => void load()
    window.addEventListener("itestflow:credentials-changed", onChange)
    return () => window.removeEventListener("itestflow:credentials-changed", onChange)
  }, [load])

  // Reset the loaded model list when the provider changes.
  useEffect(() => {
    setModels([])
    setModelsFetched(false)
  }, [provider])

  async function fetchModels() {
    setLoadingModels(true)
    setModelsFetched(false)
    try {
      const response = await fetch("/api/settings/llm-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() || undefined, baseUrl: baseUrl.trim() || undefined }),
      })
      const data = (await response.json().catch(() => ({}))) as { models?: ModelOption[]; error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not fetch models.")
        return
      }
      setModels(data.models ?? [])
      setModelsFetched(true)
      if (!data.models?.length) toast.info("No models returned by the provider.")
    } finally {
      setLoadingModels(false)
    }
  }

  async function onSave() {
    if (!apiKey.trim() || !model.trim()) {
      toast.error("Enter your API key and pick a model to update your LLM credentials.")
      return
    }
    setSaving(true)
    try {
      const response = await fetch("/api/settings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          llm: { provider, model: model.trim(), apiKey: apiKey.trim(), ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as CredentialStatusResponse & { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not save your LLM credentials.")
        return
      }
      toast.success("LLM credentials updated.")
      setApiKey("")
      setStatus(data)
      window.dispatchEvent(new CustomEvent("itestflow:credentials-changed"))
    } finally {
      setSaving(false)
    }
  }

  const badge = credentialBadge(status?.llm)
  const hasSavedKey =
    (status?.llm.status ?? "not_configured") !== "not_configured" && status?.llm.provider === provider

  return (
    <SectionCard
      title="AI Provider Configuration"
      description="Your personal LLM provider and API key, used for your own generations. The key is encrypted server-side and never returned to the browser."
      action={<StatusBadge tone={badge.tone} label={badge.label} />}
    >
      <Field label="LLM Provider" htmlFor="llm-provider">
        <NativeSelect
          id="llm-provider"
          value={provider}
          onChange={(event) => setProvider(event.target.value as Provider)}
        >
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
          <option value="anthropic">Anthropic</option>
        </NativeSelect>
      </Field>

      <SecretField
        id="llm-api-token"
        label="LLM API Token"
        value={apiKey}
        onChange={setApiKey}
        placeholder="Enter LLM API token"
        hasSaved={hasSavedKey}
        description="Re-enter your API key to change your provider or model. Leave the saved key in place otherwise."
      />

      <Field
        label="Provider Base URL (optional)"
        htmlFor="llm-base-url"
        description="Optional. Use this only for Azure OpenAI, a proxy, or another provider-compatible endpoint."
      >
        <Input
          id="llm-base-url"
          className="h-8 border-input bg-card text-foreground"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={defaultBaseUrlPlaceholder(provider)}
        />
      </Field>

      <Field
        label="LLM Model"
        htmlFor="llm-model"
        description="Opens a searchable list of available models. Uses your saved key, or the key entered above."
      >
        {modelsFetched && models.length === 0 ? (
          <Input
            id="llm-model"
            className="h-8 border-input bg-card text-foreground"
            placeholder="No models returned — type a model ID"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
        ) : (
          <SearchableCombobox
            value={model}
            options={models.map((m) => ({ value: m.id, label: m.displayName }))}
            onValueChange={setModel}
            loading={loadingModels}
            placeholder={hasSavedKey || apiKey.trim() ? "Click to browse models…" : "Save an API key first"}
            loadingText="Loading models…"
            searchPlaceholder="Search models…"
            emptyMessage="No models found."
            disabled={!hasSavedKey && !apiKey.trim()}
            onOpen={() => { if (!modelsFetched && !loadingModels) void fetchModels() }}
          />
        )}
      </Field>

      <Button type="button" onClick={() => void onSave()} disabled={saving || loading || !apiKey.trim() || !model.trim()}>
        {saving ? (
          <>
            <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : (
          "Save AI provider"
        )}
      </Button>
    </SectionCard>
  )
}

type WorkspaceSettingsResponse = {
  settings: { retrievalTopK: number | null; maxOutputTokenCap: number | null; llmRetryAttempts: number | null }
  defaults: { maxOutputTokenCapDefault: number; maxOutputTokenCapOptions: number[]; retryAttemptsDefault: number; retryAttemptsOptions: number[] }
}

/** Owner/admin workspace LLM output ceiling + retry config. Shows a notice for members. */
function OutputCapCard() {
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [value, setValue] = useState<string>("")
  const [retryAttempts, setRetryAttempts] = useState<number>(1)
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
        toast.error("Could not load the LLM output limit.")
        return
      }
      const data = (await response.json()) as WorkspaceSettingsResponse
      setDefaults(data.defaults)
      const options = data.defaults.maxOutputTokenCapOptions ?? [16000, 32000, 64000]
      setValue(
        data.settings.maxOutputTokenCap != null
          ? String(data.settings.maxOutputTokenCap)
          : String(data.defaults.maxOutputTokenCapDefault ?? options[0] ?? 32000),
      )
      setRetryAttempts(data.settings.llmRetryAttempts ?? data.defaults.retryAttemptsDefault ?? 1)
    } catch {
      toast.error("Could not load the LLM output limit.")
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
        body: JSON.stringify({ maxOutputTokenCap: Number(value), llmRetryAttempts: retryAttempts }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not save the LLM output limit.")
        return
      }
      toast.success("LLM output limit saved.")
    } finally {
      setSaving(false)
    }
  }

  const options = defaults?.maxOutputTokenCapOptions ?? [16000, 32000, 64000]
  const retryOptions = defaults?.retryAttemptsOptions ?? [0, 1, 2, 3]
  const retryLabel: Record<number, string> = { 0: "None", 1: "1×", 2: "2×", 3: "3×" }

  return (
    <SectionCard
      title="Advanced — LLM output limit"
      description="Workspace-wide ceiling on the tokens the model may generate per request. Shared by everyone in this workspace."
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : (
        <div className="space-y-4">
          <Field label="Max output tokens" description="Limits how many tokens the model can generate in a single response (output only — does not affect input context size). Lower values reduce cost; higher values allow longer outputs.">
            <div className="flex flex-wrap items-center gap-2">
              {options.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={value === String(option) ? "default" : "outline"}
                  aria-pressed={value === String(option)}
                  onClick={() => setValue(String(option))}
                  disabled={loading}
                >
                  {option.toLocaleString()}
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Retry attempts on network failure" description="How many times to retry a failed LLM request (transient errors: 408, 429, 5xx). Uses exponential back-off with up to 3 s between retries.">
            <div className="flex flex-wrap items-center gap-2">
              {retryOptions.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={retryAttempts === option ? "default" : "outline"}
                  aria-pressed={retryAttempts === option}
                  onClick={() => setRetryAttempts(option)}
                  disabled={loading}
                >
                  {retryLabel[option] ?? String(option)}
                </Button>
              ))}
            </div>
          </Field>
          <Button type="button" onClick={() => void onSave()} disabled={saving || loading}>
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
      )}
    </SectionCard>
  )
}
