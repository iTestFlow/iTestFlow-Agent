"use client"

import { Check, ChevronDown, Loader2, Menu, RefreshCw, Settings2 } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { HeaderProjectSelector } from "@/shared/components/live/project-status"
import { cn } from "@/lib/utils"

type AzureProfile = {
  displayName: string
  uniqueName?: string
  imageUrl?: string
}

type CredentialSummary = {
  status: "not_configured" | "configured" | "invalid" | "expired"
  provider?: string | null
  model?: string | null
  isStale?: boolean
}

type CredentialStatus = {
  azurePat: CredentialSummary
  llm: CredentialSummary
}

type SyncScheduleStatus = {
  enabled: boolean
  nextRunAt: string | null
  lastEnqueuedAt: string | null
}

type Provider = "openai" | "gemini" | "anthropic"
type ModelOption = { id: string; displayName: string }

function initialsFromName(value?: string) {
  if (!value) return "AD"
  const words = value.trim().split(/\s+/).filter(Boolean)
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "AD"
}

function providerLabel(value?: string | null) {
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

function isProvider(value?: string | null): value is Provider {
  return value === "openai" || value === "gemini" || value === "anthropic"
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString()
}

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [profile, setProfile] = useState<AzureProfile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null)
  const [credentialsLoading, setCredentialsLoading] = useState(true)
  const [syncSchedule, setSyncSchedule] = useState<SyncScheduleStatus | null>(null)
  const [syncScheduleLoading, setSyncScheduleLoading] = useState(true)
  const [syncScheduleVisible, setSyncScheduleVisible] = useState(true)

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

  const loadCredentials = useCallback(async () => {
    setCredentialsLoading(true)
    try {
      const response = await fetch("/api/settings/credentials", { cache: "no-store" })
      if (!response.ok) {
        setCredentials(null)
        return
      }
      setCredentials((await response.json()) as CredentialStatus)
    } catch {
      setCredentials(null)
    } finally {
      setCredentialsLoading(false)
    }
  }, [])

  const loadSyncSchedule = useCallback(async () => {
    setSyncScheduleLoading(true)
    try {
      const response = await fetch("/api/workspace/sync-schedule/status", { cache: "no-store" })
      if (response.status === 401 || response.status === 403) {
        setSyncSchedule(null)
        setSyncScheduleVisible(false)
        return
      }
      if (!response.ok) {
        setSyncSchedule(null)
        setSyncScheduleVisible(true)
        return
      }
      const data = (await response.json()) as { schedule: SyncScheduleStatus | null }
      setSyncSchedule(data.schedule)
      setSyncScheduleVisible(true)
    } catch {
      setSyncSchedule(null)
      setSyncScheduleVisible(true)
    } finally {
      setSyncScheduleLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadProfile()
    void loadCredentials()
    void loadSyncSchedule()
    const onCredentialsChange = () => void loadCredentials()
    const onSyncScheduleChange = () => void loadSyncSchedule()
    window.addEventListener("itestflow:credentials-changed", onCredentialsChange)
    window.addEventListener("itestflow:sync-schedule-changed", onSyncScheduleChange)
    return () => {
      window.removeEventListener("itestflow:credentials-changed", onCredentialsChange)
      window.removeEventListener("itestflow:sync-schedule-changed", onSyncScheduleChange)
    }
  }, [loadProfile, loadCredentials, loadSyncSchedule])

  const azureConfiguredError = profileError?.toLowerCase().includes("not configured") || profileError?.toLowerCase().includes("personal access token")
  const azureStatus = profile
    ? { text: "Azure: Connected", tone: "connected" as const, title: `Azure DevOps connected as ${profile.displayName}` }
    : profileError
      ? {
          text: azureConfiguredError ? "Azure: Not configured" : "Azure: Unavailable",
          tone: azureConfiguredError ? "missing" as const : "warning" as const,
          title: profileError,
        }
      : { text: "Azure: Checking", tone: "checking" as const, title: "Checking Azure DevOps connection." }

  const llm = credentials?.llm
  const llmConnected = llm?.status === "configured"
  const llmStatus = llmConnected
    ? {
        text: `LLM: ${providerLabel(llm?.provider)} / ${llm?.model ?? ""}`.trim(),
        tone: "connected" as const,
        title: `LLM configured: ${providerLabel(llm?.provider)}${llm?.model ? ` using ${llm.model}` : ""}`,
      }
    : credentialsLoading
      ? { text: "LLM: Checking", tone: "checking" as const, title: "Checking your LLM credentials." }
      : {
          text: "LLM: Not configured",
          tone: "missing" as const,
          title: "Add your LLM provider, model, and API key in Settings → My Credentials.",
        }

  const syncStatus = syncScheduleLoading
    ? { text: "Sync: Checking", tone: "checking" as const, title: "Checking scheduled knowledge sync." }
    : !syncSchedule
      ? { text: "Sync: No schedule", tone: "missing" as const, title: "No scheduled knowledge sync is configured." }
      : syncSchedule.enabled
        ? {
            text: "Sync: Enabled",
            tone: syncSchedule.nextRunAt ? "connected" as const : "warning" as const,
            title: syncSchedule.nextRunAt
              ? `Scheduled knowledge sync is enabled. Next sync: ${formatDateTime(syncSchedule.nextRunAt)}.`
              : "Scheduled knowledge sync is enabled, but the next sync time is not available.",
          }
        : {
            text: "Sync: Disabled",
            tone: "warning" as const,
            title: syncSchedule.lastEnqueuedAt
              ? `Scheduled knowledge sync is disabled. Last enqueued: ${formatDateTime(syncSchedule.lastEnqueuedAt)}.`
              : "Scheduled knowledge sync is disabled.",
          }

  // Proactive PAT health: only surfaced when there's a problem (expired/rejected
  // at use-time, or stale). A healthy PAT shows nothing extra here.
  const pat = credentials?.azurePat
  const patWarning =
    pat?.status === "expired" || pat?.status === "invalid"
      ? { text: "Azure PAT: Expired", title: "Azure DevOps rejected your PAT. Re-enter it in Settings → My Credentials." }
      : pat?.isStale
        ? { text: "Azure PAT: Re-validate", title: "Your Azure DevOps PAT hasn't been validated in a while. Re-enter it in Settings → My Credentials." }
        : null

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
        {patWarning ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href="/settings"
                className={connectivityChipClass("warning", "max-w-[220px] cursor-pointer hover:brightness-95")}
                aria-label={patWarning.title}
              >
                <span className="truncate">{patWarning.text}</span>
                <Settings2 className="size-3.5 shrink-0" />
              </Link>
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-sm text-left">{patWarning.title}</TooltipContent>
          </Tooltip>
        ) : null}
        <LlmModelChip
          status={llmStatus}
          provider={isProvider(llm?.provider) ? llm.provider : null}
          model={llm?.model ?? ""}
          disabled={credentialsLoading}
          onChanged={loadCredentials}
        />
        {syncScheduleVisible ? <ConnectivityChip {...syncStatus} className="max-w-[170px]" /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void loadProfile()
            void loadCredentials()
            void loadSyncSchedule()
          }}
          disabled={profileLoading || credentialsLoading || syncScheduleLoading}
          aria-label="Refresh Azure DevOps, credential, and sync status"
          title="Refresh Azure DevOps, credential, and sync status"
        >
          <RefreshCw className={cn("size-3.5", (profileLoading || credentialsLoading || syncScheduleLoading) && "animate-spin")} />
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

function ConnectivityChip({
  text,
  title,
  tone,
  className = "",
}: {
  text: string
  title: string
  tone: "connected" | "checking" | "missing" | "warning"
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={connectivityChipClass(tone, className)} aria-label={title}>
          <span className="truncate">{text}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={8} className="max-w-sm text-left">
        {title}
      </TooltipContent>
    </Tooltip>
  )
}

function LlmModelChip({
  status,
  provider,
  model,
  disabled,
  onChanged,
}: {
  status: { text: string; title: string; tone: "connected" | "checking" | "missing" | "warning" }
  provider: Provider | null
  model: string
  disabled: boolean
  onChanged: () => void
}) {
  const configured = status.tone === "connected" && provider
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelOption[]>([])
  const [search, setSearch] = useState("")
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelsFetched, setModelsFetched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingModel, setSavingModel] = useState<string | null>(null)

  useEffect(() => {
    setModels([])
    setModelsFetched(false)
    setError(null)
    setSearch("")
  }, [provider])

  const filteredModels = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    if (!needle) return models
    return models.filter((entry) => `${entry.id} ${entry.displayName}`.toLocaleLowerCase().includes(needle))
  }, [models, search])

  async function fetchModels() {
    if (!provider || loadingModels) return
    setLoadingModels(true)
    setError(null)
    try {
      const response = await fetch("/api/settings/llm-models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      const data = (await response.json().catch(() => ({}))) as { models?: ModelOption[]; error?: string }
      if (!response.ok) {
        setError(data.error ?? "Could not fetch models.")
        return
      }
      setModels(data.models ?? [])
      setModelsFetched(true)
    } finally {
      setLoadingModels(false)
    }
  }

  async function saveModel(nextModel: string) {
    if (!provider || !nextModel || nextModel === model) {
      setOpen(false)
      return
    }
    setSavingModel(nextModel)
    try {
      const response = await fetch("/api/settings/credentials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ llm: { provider, model: nextModel } }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not update the LLM model.")
        return
      }
      toast.success(`LLM model switched to ${nextModel}.`)
      window.dispatchEvent(new CustomEvent("itestflow:credentials-changed"))
      onChanged()
      setOpen(false)
    } finally {
      setSavingModel(null)
    }
  }

  if (!configured) {
    return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href="/settings" className={connectivityChipClass(status.tone, "max-w-[260px] cursor-pointer hover:brightness-95")} aria-label={status.title}>
              <span className="truncate">{status.text}</span>
            </Link>
          </TooltipTrigger>
          <TooltipContent sideOffset={8} className="max-w-sm text-left">{status.title}</TooltipContent>
        </Tooltip>
    )
  }

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen && !modelsFetched && !loadingModels) void fetchModels()
        if (!nextOpen) setSearch("")
      }}
    >
      <div className={connectivityChipClass(status.tone, "max-w-[260px] overflow-hidden")}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left hover:brightness-95 disabled:pointer-events-none disabled:opacity-60"
            disabled={disabled}
            aria-label={`${status.title}. Change LLM model.`}
            title={`${status.title}. Click to change model.`}
          >
            <span className="truncate">{status.text}</span>
            {loadingModels || savingModel ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
            )}
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="end" className="w-[min(520px,calc(100vw-2rem))] p-0">
        <Command shouldFilter={false}>
          <CommandInput value={search} onValueChange={setSearch} placeholder="Search models..." />
          <CommandList className="max-h-80">
            {loadingModels ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading models...
              </div>
            ) : null}
            {!loadingModels && error ? (
              <div className="space-y-3 px-3 py-4 text-sm">
                <div className="text-destructive">{error}</div>
                <div className="flex items-center gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => void fetchModels()}>
                    Retry
                  </Button>
                  <Button type="button" variant="ghost" size="sm" asChild>
                    <Link href="/settings">Open settings</Link>
                  </Button>
                </div>
              </div>
            ) : null}
            {!loadingModels && !error ? (
              <>
                <CommandEmpty>{modelsFetched ? "No models found." : "Open the list to load models."}</CommandEmpty>
                <CommandGroup heading={`${providerLabel(provider)} models`}>
                  {filteredModels.map((entry) => {
                    const selected = entry.id === model
                    const saving = savingModel === entry.id
                    return (
                      <CommandItem
                        key={entry.id}
                        value={entry.id}
                        data-checked={selected}
                        onSelect={() => void saveModel(entry.id)}
                        disabled={Boolean(savingModel)}
                        className="items-start gap-2"
                      >
                        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
                          {saving ? <Loader2 className="size-4 animate-spin" /> : selected ? <Check className="size-4" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{entry.displayName}</span>
                          {entry.displayName !== entry.id ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{entry.id}</span> : null}
                        </span>
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
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
