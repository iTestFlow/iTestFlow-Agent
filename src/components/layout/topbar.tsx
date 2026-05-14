"use client"

import { Menu } from "lucide-react"
import { useEffect, useState } from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { HeaderProjectSelector } from "@/shared/components/live/project-status"

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
      return "Claude"
    case "ollama":
      return "Ollama"
    default:
      return value ? value : "LLM"
  }
}

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [profile, setProfile] = useState<AzureProfile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [settingsSummary, setSettingsSummary] = useState<RuntimeSettingsSummary | null>(null)
  const [settingsError, setSettingsError] = useState(false)

  useEffect(() => {
    fetch("/api/azure-devops/profile", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok) throw new Error(json.error ?? "Failed to fetch Azure DevOps profile.")
        setProfile(json.user ?? null)
        setProfileError(null)
      })
      .catch((error: unknown) => {
        setProfile(null)
        setProfileError(error instanceof Error ? error.message : "Azure DevOps user unavailable.")
      })

    fetch("/api/settings/runtime", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json()
        if (!response.ok) throw new Error(json.error ?? "Failed to fetch runtime settings.")
        setSettingsSummary(json)
        setSettingsError(false)
      })
      .catch(() => {
        setSettingsSummary({ configured: false })
        setSettingsError(true)
      })
  }, [])

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

      <div className="flex min-w-0 items-center gap-2">
        <ConnectivityChip {...azureStatus} />
        <ConnectivityChip {...llmStatus} className="max-w-[260px]" />
      </div>

      <ThemeToggle />

      <div className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background/70 px-2 py-1.5">
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
  const styles = {
    connected: "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 before:bg-emerald-500",
    checking: "border-slate-500/25 bg-slate-500/10 text-slate-600 dark:text-slate-300 before:bg-slate-400",
    missing: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300 before:bg-amber-500",
    warning: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300 before:bg-red-500",
  }[tone]

  return (
    <span
      className={`inline-flex h-8 min-w-0 items-center gap-1.5 rounded-[6px] border px-2.5 text-xs font-medium ${styles} before:size-1.5 before:shrink-0 before:rounded-full ${className}`}
      title={title}
    >
      <span className="truncate">{text}</span>
    </span>
  )
}
