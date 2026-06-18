"use client"

import { CalendarClock, ChevronDown, Loader2, Menu, RefreshCw, Settings2 } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { HeaderProjectSelector } from "@/shared/components/live/project-status"
import { ModelPicker, useProviderModels } from "@/shared/components/live/model-picker"
import { dispatchRuntimeSettingsChanged, subscribeRuntimeSettingsChanged } from "@/shared/lib/runtime-settings-events"
import { apiErrorMessage } from "@/shared/validators/api-validation-errors"
import { cn } from "@/lib/utils"
import { isCronExpressionDue } from "@/modules/settings/cron-expression"

type AzureProfile = {
  displayName: string
  uniqueName?: string
  imageUrl?: string
}

type RuntimeSettingsSummary = {
  configured: boolean
  llm?: {
    provider?: string
    model?: string
    hasApiKey?: boolean
    baseUrl?: string
  }
  context?: {
    autoUpdate?: {
      enabled: boolean
      cronExpression: string
      projectScope?: {
        azureProjectName: string
      } | null
    }
  }
}

function initialsFromName(value?: string) {
  if (!value) return "AD"
  const words = value.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "AD"
}

function providerLabel(value?: string) {
  switch (value) {
    case "openai":
      return "OpenAI"
    case "gemini":
      return "Gemini"
    case "anthropic":
      return "Anthropic"
    default:
      return value ? value : "LLM"
  }
}

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [profile, setProfile] = useState<AzureProfile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [settingsSummary, setSettingsSummary] = useState<RuntimeSettingsSummary | null>(null)
  const [settingsError, setSettingsError] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(true)

  const loadProfile = useCallback(async () => {
    setProfileLoading(true)
    try {
      const response = await fetch("/api/azure-devops/profile", { cache: "no-store" })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? "Failed to fetch Azure DevOps profile.")
      setProfile(json.user ?? null)
      setProfileError(null)
    } catch (error: unknown) {
      setProfile(null)
      setProfileError(error instanceof Error ? error.message : "Azure DevOps user unavailable.")
    } finally {
      setProfileLoading(false)
    }
  }, [])

  const loadSettingsSummary = useCallback(async () => {
    setSettingsLoading(true)
    try {
      const response = await fetch("/api/settings/runtime", { cache: "no-store" })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? "Failed to fetch runtime settings.")
      setSettingsSummary(json)
      setSettingsError(false)
    } catch {
      setSettingsSummary({ configured: false })
      setSettingsError(true)
    } finally {
      setSettingsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProfile()
    void loadSettingsSummary()
  }, [loadProfile, loadSettingsSummary])

  useEffect(() => {
    return subscribeRuntimeSettingsChanged<RuntimeSettingsSummary>((detail) => {
      if (detail) {
        setSettingsSummary(detail)
        setSettingsError(false)
        setSettingsLoading(false)
        return
      }

      void loadSettingsSummary()
    })
  }, [loadSettingsSummary])

  const azureConfiguredError = profileError?.toLowerCase().includes("not configured")
  const azureStatus = profile
    ? { text: "Azure: Connected", tone: "connected" as const, title: `Azure DevOps connected as ${profile.displayName}` }
    : profileError
      ? {
          text: azureConfiguredError ? "Azure: Not configured" : "Azure: Unavailable",
          tone: azureConfiguredError ? "missing" as const : "warning" as const,
          title: profileError,
        }
      : { text: "Azure: Checking", tone: "checking" as const, title: "Checking Azure DevOps connection." }

  const llm = settingsSummary?.llm
  const llmConnected = Boolean(settingsSummary?.configured && llm?.provider && llm.model && llm.hasApiKey)
  const llmStatus = llmConnected
    ? {
        text: `LLM: ${providerLabel(llm?.provider)} / ${llm?.model}`,
        tone: "connected" as const,
        title: `LLM configured: ${providerLabel(llm?.provider)} using ${llm?.model}`,
      }
    : !settingsSummary && !settingsError
      ? {
          text: "LLM: Checking",
          tone: "checking" as const,
          title: "Checking runtime LLM configuration.",
        }
    : {
        text: settingsError ? "LLM: Unavailable" : "LLM: Not configured",
        tone: settingsError ? "warning" as const : "missing" as const,
        title: settingsError
          ? "Runtime settings could not be loaded."
          : "Configure an LLM provider, model, and API key in Settings.",
      }
  const cronStatus = useMemo(() => getCronStatus(settingsSummary, settingsError), [settingsSummary, settingsError])

  return (
    <header className="sticky top-0 z-30 flex min-h-16 items-center gap-3 border-b border-border bg-card/95 px-4 text-card-foreground shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenSidebar}
        aria-label="Open navigation"
      >
        <Menu className="size-4" />
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <HeaderProjectSelector />
      </div>

      <div className="hidden min-w-0 items-center gap-2 xl:flex">
        <ConnectivityChip {...azureStatus} />
        <LLMModelSwitcher
          status={llmStatus}
          settingsSummary={settingsSummary}
          settingsError={settingsError}
          onSettingsSummaryChange={(summary) => {
            setSettingsSummary(summary)
            setSettingsError(false)
            dispatchRuntimeSettingsChanged(summary)
          }}
        />
        <ConnectivityChip {...cronStatus} className="max-w-[150px]" icon={<CalendarClock className="size-3.5 shrink-0" />} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void loadProfile()
            void loadSettingsSummary()
          }}
          disabled={profileLoading || settingsLoading}
          aria-label="Refresh Azure DevOps and LLM status"
          title="Refresh Azure DevOps and LLM status"
        >
          <RefreshCw className={cn("size-3.5", (profileLoading || settingsLoading) && "animate-spin")} />
        </Button>
      </div>

      <ThemeToggle />

      <div className="hidden shrink-0 items-center gap-2 rounded-lg border border-border bg-background/70 px-2 py-1.5 sm:flex">
        <Avatar className="size-7">
          {profile?.imageUrl ? <AvatarImage src={profile.imageUrl} alt="" /> : null}
          <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
            {initialsFromName(profile?.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="hidden min-w-0 sm:block">
          <div className="max-w-48 truncate text-sm font-medium text-foreground">
            {profile?.displayName ?? (profileError ? "Azure DevOps user unavailable" : "Loading Azure DevOps user")}
          </div>
          {profile?.uniqueName ? <div className="max-w-48 truncate text-xs text-muted-foreground">{profile.uniqueName}</div> : null}
        </div>
      </div>

    </header>
  )
}

function LLMModelSwitcher({
  status,
  settingsSummary,
  settingsError,
  onSettingsSummaryChange,
}: {
  status: {
    text: string
    title: string
    tone: "connected" | "checking" | "missing" | "warning"
  }
  settingsSummary: RuntimeSettingsSummary | null
  settingsError: boolean
  onSettingsSummaryChange: (summary: RuntimeSettingsSummary) => void
}) {
  const [open, setOpen] = useState(false)
  const [savingModelId, setSavingModelId] = useState<string | null>(null)
  const { models, loading: modelsLoading, error: modelError, load, reset } = useProviderModels()

  const llm = settingsSummary?.llm
  const settingsChecking = !settingsSummary && !settingsError
  const hasConfiguredProvider = Boolean(settingsSummary?.configured && llm?.provider && llm.model)
  const canSwitchModel = Boolean(hasConfiguredProvider && llm?.hasApiKey && !settingsError)
  const currentProviderLabel = providerLabel(llm?.provider)
  const currentModel = llm?.model ?? ""

  const loadModels = useCallback(() => {
    if (!llm?.provider) return
    void load({ provider: llm.provider })
  }, [llm?.provider, load])

  useEffect(() => {
    if (open && canSwitchModel) loadModels()
  }, [canSwitchModel, loadModels, open])

  useEffect(() => {
    reset()
    setSavingModelId(null)
  }, [llm?.provider, reset])

  async function selectModel(modelId: string) {
    if (modelId === currentModel) {
      setOpen(false)
      return
    }

    setSavingModelId(modelId)
    try {
      const response = await fetch("/api/settings/runtime", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: { model: modelId } }),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(apiErrorMessage(json, "Could not update LLM model."))

      onSettingsSummaryChange(json as RuntimeSettingsSummary)
      toast.success(`LLM model changed to ${modelId}.`)
      setOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update LLM model.")
    } finally {
      setSavingModelId(null)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(connectivityChipClass(status.tone, "max-w-[260px] cursor-pointer pr-2 hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"))}
          aria-label={canSwitchModel ? `${status.title}. Change LLM model.` : status.title}
          title={canSwitchModel ? `${status.title}. Change LLM model.` : status.title}
        >
          <span className="truncate">{status.text}</span>
          {canSwitchModel ? <ChevronDown className="size-3.5 shrink-0" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-[380px] max-w-[calc(100vw-2rem)] gap-0 p-0">
        <div className="border-b border-border p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">LLM model</div>
              <div className="mt-1 truncate text-xs text-muted-foreground">
                {hasConfiguredProvider
                  ? `${currentProviderLabel} / ${currentModel}`
                  : settingsChecking
                    ? "Checking runtime configuration..."
                    : "No LLM runtime configuration found."}
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" asChild aria-label="Open Settings">
              <Link href="/settings">
                <Settings2 className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        {!canSwitchModel ? (
          <div className="space-y-3 p-3 text-sm text-muted-foreground">
            {settingsChecking ? (
              <div className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin text-primary" />
                Checking runtime settings...
              </div>
            ) : (
              <>
                <p>
                  {settingsError
                    ? "Runtime settings could not be loaded."
                    : hasConfiguredProvider
                      ? "Save the selected provider API token in Settings before loading live models."
                      : "Configure an LLM provider, model, and API token in Settings."}
                </p>
                <Button size="sm" asChild>
                  <Link href="/settings">Open Settings</Link>
                </Button>
              </>
            )}
          </div>
        ) : (
          <ModelPicker
            models={models}
            loading={modelsLoading}
            error={modelError}
            providerLabel={currentProviderLabel}
            currentModel={currentModel}
            savingModelId={savingModelId}
            onRetry={loadModels}
            onSelect={(modelId) => void selectModel(modelId)}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

function ConnectivityChip({
  text,
  title,
  tone,
  className = "",
  icon,
}: {
  text: string
  title: string
  tone: "connected" | "checking" | "missing" | "warning"
  className?: string
  icon?: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={connectivityChipClass(tone, className)}
          aria-label={title}
        >
          {icon}
          <span className="truncate">{text}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={8} className="max-w-sm text-left">
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

function connectivityChipClass(
  tone: "connected" | "checking" | "missing" | "warning",
  className = "",
) {
  const styles = {
    connected: "border-success/30 bg-success/10 text-success before:bg-success",
    checking: "border-border bg-muted text-muted-foreground before:bg-muted-foreground",
    missing: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning before:bg-warning",
    warning: "border-destructive/30 bg-destructive/10 text-destructive before:bg-destructive",
  }[tone]

  return cn(
    "inline-flex h-8 min-w-0 items-center gap-1.5 rounded-[6px] border px-2.5 text-xs font-medium before:size-1.5 before:shrink-0 before:rounded-full",
    styles,
    className,
  )
}

function getCronStatus(summary: RuntimeSettingsSummary | null, settingsError: boolean) {
  if (!summary && !settingsError) {
    return {
      text: "Sync: Checking",
      tone: "checking" as const,
      title: "Checking automatic project context update schedule.",
    }
  }

  if (settingsError) {
    return {
      text: "Sync: Unavailable",
      tone: "warning" as const,
      title: "Runtime settings could not be loaded, so the automatic project context update schedule is unavailable.",
    }
  }

  const autoUpdate = summary?.context?.autoUpdate
  if (!summary?.configured || !autoUpdate?.enabled) {
    return {
      text: "Sync: Off",
      tone: "missing" as const,
      title: "Automatic project context and knowledge base updates are disabled. Enable them in Settings.",
    }
  }

  const nextRun = findNextCronRun(autoUpdate.cronExpression)
  const projectName = autoUpdate.projectScope?.azureProjectName
  const projectText = projectName ? ` for ${projectName}` : ""

  return {
    text: "Sync: On",
    tone: "connected" as const,
    title: nextRun
      ? `Next automatic project context update${projectText}: ${formatDateTime(nextRun)} local server time. Cron: ${autoUpdate.cronExpression}.`
      : `Automatic project context updates are enabled${projectText}, but the next trigger could not be calculated from cron: ${autoUpdate.cronExpression}.`,
  }
}

function findNextCronRun(expression: string, from = new Date()) {
  const candidate = new Date(from)
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)

  const maxChecks = 60 * 24 * 366
  for (let index = 0; index < maxChecks; index += 1) {
    if (isCronExpressionDue(expression, candidate)) return new Date(candidate)
    candidate.setMinutes(candidate.getMinutes() + 1)
  }

  return null
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(value)
}
