"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { SearchableCombobox } from "@/components/ui/searchable-combobox"
import { OwnerOnlyNotice } from "./owner-only-notice"
import { apiErrorMessage } from "@/shared/lib/api-error-message"
import {
  Field,
  SecretField,
  SectionCard,
  SettingCheckbox,
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

const PROVIDERS: Provider[] = ["openai", "gemini", "anthropic", "xai"]

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
      setModel(data.llm.model ?? "")
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

  function onProviderChange(nextProvider: Provider) {
    setProvider(nextProvider)
    setModel(status?.llm.provider === nextProvider ? status.llm.model ?? "" : "")
    setModels([])
    setModelsFetched(false)
  }

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
        toast.error(apiErrorMessage(data, "Could not fetch models."))
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
          llm: {
            provider,
            model: model.trim(),
            apiKey: apiKey.trim(),
            ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
          },
        }),
      })
      const data = (await response.json().catch(() => ({}))) as CredentialStatusResponse & { error?: string }
      if (!response.ok) {
        toast.error(apiErrorMessage(data, "Could not save your LLM credentials."))
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
          onChange={(event) => onProviderChange(event.target.value as Provider)}
        >
          <option value="openai">OpenAI</option>
          <option value="gemini">Gemini</option>
          <option value="anthropic">Anthropic</option>
          <option value="xai">xAI (Grok)</option>
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
  workspaceId?: string
  settings: {
    retrievalTopK: number | null
    maxOutputTokenCap: number | null
    modelInputTokenLimitOverride: number | null
    llmRetryAttempts: number | null
    externalLlmEnabled?: boolean
  }
  defaults: {
    maxOutputTokenCapDefault: number
    maxOutputTokenCapOptions: number[]
    modelInputTokenLimitOverrideOptions: number[]
    retryAttemptsDefault: number
    retryAttemptsOptions: number[]
  }
}

type WorkspaceAiControls = {
  maxOutputTokenCap: string
  modelInputTokenLimitOverride: string
  llmRetryAttempts: number
  externalLlmEnabled: boolean
}

function workspaceAiControlsFromResponse(data: WorkspaceSettingsResponse): WorkspaceAiControls {
  const options = data.defaults.maxOutputTokenCapOptions ?? [16000, 32000, 64000]
  return {
    maxOutputTokenCap:
      data.settings.maxOutputTokenCap != null
        ? String(data.settings.maxOutputTokenCap)
        : String(data.defaults.maxOutputTokenCapDefault ?? options[0] ?? 32000),
    modelInputTokenLimitOverride:
      data.settings.modelInputTokenLimitOverride != null ? String(data.settings.modelInputTokenLimitOverride) : "",
    llmRetryAttempts: data.settings.llmRetryAttempts ?? data.defaults.retryAttemptsDefault ?? 1,
    externalLlmEnabled: data.settings.externalLlmEnabled ?? true,
  }
}

/** Owner/admin workspace AI controls. Shows a notice for members. */
function OutputCapCard() {
  const [forbidden, setForbidden] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [value, setValue] = useState<string>("")
  const [modelInputLimit, setModelInputLimit] = useState<string>("")
  const [retryAttempts, setRetryAttempts] = useState<number>(1)
  const [externalLlmEnabled, setExternalLlmEnabled] = useState(true)
  const [baseline, setBaseline] = useState<WorkspaceAiControls | null>(null)
  const [defaults, setDefaults] = useState<WorkspaceSettingsResponse["defaults"] | null>(null)

  const applyWorkspaceSettings = useCallback((data: WorkspaceSettingsResponse) => {
    const next = workspaceAiControlsFromResponse(data)
    setDefaults(data.defaults)
    setValue(next.maxOutputTokenCap)
    setModelInputLimit(next.modelInputTokenLimitOverride)
    setRetryAttempts(next.llmRetryAttempts)
    setExternalLlmEnabled(next.externalLlmEnabled)
    setBaseline(next)
  }, [])

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
      applyWorkspaceSettings(data)
    } catch {
      toast.error("Could not load the LLM output limit.")
    } finally {
      setLoading(false)
    }
  }, [applyWorkspaceSettings])

  useEffect(() => {
    void load()
  }, [load])

  async function onSave() {
    if (!baseline) return

    const changes: {
      maxOutputTokenCap?: number
      modelInputTokenLimitOverride?: number | null
      llmRetryAttempts?: number
      externalLlmEnabled?: boolean
    } = {}
    if (value !== baseline.maxOutputTokenCap) changes.maxOutputTokenCap = Number(value)
    if (modelInputLimit !== baseline.modelInputTokenLimitOverride) {
      changes.modelInputTokenLimitOverride = modelInputLimit ? Number(modelInputLimit) : null
    }
    if (retryAttempts !== baseline.llmRetryAttempts) changes.llmRetryAttempts = retryAttempts
    if (externalLlmEnabled !== baseline.externalLlmEnabled) changes.externalLlmEnabled = externalLlmEnabled

    if (Object.keys(changes).length === 0) {
      toast.info("No workspace AI control changes to save.")
      return
    }

    setSaving(true)
    try {
      const response = await fetch("/api/workspace/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      })
      const data = (await response.json().catch(() => ({}))) as WorkspaceSettingsResponse & { error?: string }
      if (!response.ok) {
        toast.error(apiErrorMessage(data, "Could not save workspace AI controls."))
        return
      }
      applyWorkspaceSettings(data)
      if (changes.externalLlmEnabled !== undefined) {
        window.dispatchEvent(new CustomEvent("itestflow:workspace-capabilities-changed", { detail: { workspaceId: data.workspaceId } }))
      }
      toast.success("Workspace AI controls saved.")
    } finally {
      setSaving(false)
    }
  }

  const options = defaults?.maxOutputTokenCapOptions ?? [16000, 32000, 64000]
  const inputLimitOptions = defaults?.modelInputTokenLimitOverrideOptions ?? [16000, 32000, 64000, 128000, 200000, 1000000, 2000000]
  const retryOptions = defaults?.retryAttemptsOptions ?? [0, 1, 2, 3]
  const retryLabel: Record<number, string> = { 0: "None", 1: "1×", 2: "2×", 3: "3×" }

  return (
    <SectionCard
      title="Workspace AI controls"
      description="Workspace-wide generation controls shared by everyone in this workspace."
    >
      {forbidden ? (
        <OwnerOnlyNotice />
      ) : loading ? (
        <div className="text-sm text-muted-foreground" aria-live="polite">
          Loading workspace AI controls…
        </div>
      ) : (
        <div className="space-y-4">
          <SettingCheckbox
            id="external-llm-enabled"
            label="Allow External LLM"
            description="Lets members prepare structured prompts and validate pasted External LLM responses. Auto Generate and saved provider credentials are unaffected."
            checked={externalLlmEnabled}
            onCheckedChange={setExternalLlmEnabled}
            disabled={loading || saving}
          />
          <Field label="Max output tokens" description="Limits how many tokens the model can generate in a single response (output only — does not affect input context size). Lower values reduce cost; higher values allow longer outputs.">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Max output tokens">
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
          <Field label="Model input limit override (optional)" description="Applies to every member. Choose Automatic to use the model's known context limit; unknown models use a conservative 16,000-token fallback.">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Model input limit override">
              <Button
                type="button"
                size="sm"
                variant={modelInputLimit === "" ? "default" : "outline"}
                aria-pressed={modelInputLimit === ""}
                onClick={() => setModelInputLimit("")}
                disabled={loading || saving}
              >
                Automatic
              </Button>
              {inputLimitOptions.map((option) => (
                <Button
                  key={option}
                  type="button"
                  size="sm"
                  variant={modelInputLimit === String(option) ? "default" : "outline"}
                  aria-pressed={modelInputLimit === String(option)}
                  onClick={() => setModelInputLimit(String(option))}
                  disabled={loading || saving}
                >
                  {option.toLocaleString()}
                </Button>
              ))}
            </div>
          </Field>
          <Field label="Retry attempts on network failure" description="How many times to retry a failed LLM request (transient errors: 408, 429, 5xx). Uses exponential back-off with up to 3 s between retries.">
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Retry attempts on network failure">
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
          <Button type="button" onClick={() => void onSave()} disabled={saving || loading || !baseline}>
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
