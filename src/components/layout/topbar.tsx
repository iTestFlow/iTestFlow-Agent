"use client"

import { Menu, RefreshCw, Settings2 } from "lucide-react"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
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

export function Topbar({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const [profile, setProfile] = useState<AzureProfile | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileLoading, setProfileLoading] = useState(true)
  const [credentials, setCredentials] = useState<CredentialStatus | null>(null)
  const [credentialsLoading, setCredentialsLoading] = useState(true)

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

  useEffect(() => {
    void loadProfile()
    void loadCredentials()
    const onChange = () => void loadCredentials()
    window.addEventListener("itestflow:credentials-changed", onChange)
    return () => window.removeEventListener("itestflow:credentials-changed", onChange)
  }, [loadProfile, loadCredentials])

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
        <Tooltip>
          <TooltipTrigger asChild>
            <Link href="/settings" className={connectivityChipClass(llmStatus.tone, "max-w-[260px] cursor-pointer hover:brightness-95")} aria-label={llmStatus.title}>
              <span className="truncate">{llmStatus.text}</span>
              <Settings2 className="size-3.5 shrink-0" />
            </Link>
          </TooltipTrigger>
          <TooltipContent sideOffset={8} className="max-w-sm text-left">{llmStatus.title}</TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void loadProfile()
            void loadCredentials()
          }}
          disabled={profileLoading || credentialsLoading}
          aria-label="Refresh Azure DevOps and credential status"
          title="Refresh Azure DevOps and credential status"
        >
          <RefreshCw className={cn("size-3.5", (profileLoading || credentialsLoading) && "animate-spin")} />
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
