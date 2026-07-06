"use client"

import { Check, ChevronDown, Eye, EyeOff, KeyRound, Loader2, LogOut, Menu, RefreshCw, Settings2, UserRound } from "lucide-react"
import { forwardRef, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react"
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ThemeToggle } from "@/components/theme/theme-toggle"
import { HeaderProjectSelector } from "@/shared/components/live/project-status"
import { cn } from "@/lib/utils"
import { NavigationLink } from "@/components/navigation/navigation-link"
import { isProvider, modelDisplayLabel, providerLabel, type Provider } from "@/components/layout/topbar-labels"

type AzureProfile = {
  displayName: string
  uniqueName?: string
  imageUrl?: string
}

type CredentialSummary = {
  status: "not_configured" | "configured" | "invalid" | "expired"
  maskedPreview?: string | null
  lastValidatedAt?: string | null
  provider?: string | null
  model?: string | null
  isStale?: boolean
}

type CredentialStatus = {
  azurePat: CredentialSummary
  llm: CredentialSummary
}

type WorkspaceRole = "owner" | "admin" | "member"

type SessionSummary = {
  authenticated: boolean
  userId?: string
  membership?: {
    workspaceId: string
    role: WorkspaceRole
  } | null
}

type SyncScheduleStatus = {
  enabled: boolean
  nextRunAt: string | null
  lastEnqueuedAt: string | null
}

type ModelOption = { id: string; displayName: string }
type HeaderStatus = "success" | "warning" | "error" | "neutral" | "loading"

function roleLabel(role: WorkspaceRole) {
  switch (role) {
    case "owner":
      return "Owner"
    case "admin":
      return "Admin"
    case "member":
      return "Member"
  }
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
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole | null>(null)
  const [workspaceRoleLoading, setWorkspaceRoleLoading] = useState(true)
  const [loggingOut, setLoggingOut] = useState(false)
  const [patDialogOpen, setPatDialogOpen] = useState(false)
  const [patInput, setPatInput] = useState("")
  const [patReveal, setPatReveal] = useState(false)
  const [patSaving, setPatSaving] = useState(false)

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

  const loadSession = useCallback(async () => {
    setWorkspaceRoleLoading(true)
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store" })
      if (!response.ok) {
        setWorkspaceRole(null)
        return
      }
      const data = (await response.json()) as SessionSummary
      setWorkspaceRole(data.authenticated ? data.membership?.role ?? null : null)
    } catch {
      setWorkspaceRole(null)
    } finally {
      setWorkspaceRoleLoading(false)
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

  const handleLogout = useCallback(async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      const response = await fetch("/api/auth/logout", { method: "POST", cache: "no-store" })
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? "Could not log out.")
      }
      window.location.assign("/login")
    } catch (error) {
      setLoggingOut(false)
      toast.error(error instanceof Error ? error.message : "Could not log out.")
    }
  }, [loggingOut])

  const handlePatDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (patSaving) return
      setPatDialogOpen(nextOpen)
      if (nextOpen && !credentials && !credentialsLoading) void loadCredentials()
      if (!nextOpen) {
        setPatInput("")
        setPatReveal(false)
      }
    },
    [credentials, credentialsLoading, loadCredentials, patSaving],
  )

  const handleReplacePat = useCallback(async () => {
    const nextPat = patInput.trim()
    if (!nextPat) {
      toast.error("Enter your new Azure DevOps PAT.")
      return
    }

    setPatSaving(true)
    try {
      const response = await fetch("/api/settings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ azurePat: nextPat }),
      })
      const data = (await response.json().catch(() => ({}))) as CredentialStatus & { error?: string }
      if (!response.ok) {
        toast.error(data.error ?? "Could not replace your PAT.")
        return
      }

      toast.success("Azure DevOps PAT replaced.")
      setCredentials({ azurePat: data.azurePat, llm: data.llm })
      setPatInput("")
      setPatReveal(false)
      setPatDialogOpen(false)
      window.dispatchEvent(new CustomEvent("itestflow:credentials-changed"))
      void loadProfile()
    } finally {
      setPatSaving(false)
    }
  }, [loadProfile, patInput])

  useEffect(() => {
    void loadProfile()
    void loadSession()
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
  }, [loadProfile, loadSession, loadCredentials, loadSyncSchedule])

  const azureConfiguredError = profileError?.toLowerCase().includes("not configured") || profileError?.toLowerCase().includes("personal access token")
  const azureStatus = profile
    ? { label: "Azure", status: "success" as const, detail: `Azure DevOps connected as ${profile.displayName}.` }
    : profileError
      ? {
          label: azureConfiguredError ? "Azure Off" : "Azure Issue",
          status: "error" as const,
          detail: `Azure DevOps ${azureConfiguredError ? "is not configured" : "is unavailable"}. ${profileError}`,
        }
      : { label: "Azure", status: "loading" as const, detail: "Checking Azure DevOps connection." }

  const llm = credentials?.llm
  const llmConnected = llm?.status === "configured"
  const llmStatus = llmConnected
    ? {
        label: modelDisplayLabel(llm?.provider, llm?.model),
        status: "success" as const,
        detail: `LLM configured. Provider: ${providerLabel(llm?.provider)}.${llm?.model ? ` Model: ${llm.model}.` : ""}`,
      }
    : credentialsLoading
      ? { label: "LLM", status: "loading" as const, detail: "Checking your LLM credentials." }
      : {
          label: "LLM Off",
          status: "warning" as const,
          detail: "LLM is not configured. Add your provider, model, and API key in Settings → My Credentials.",
        }

  const syncStatus = syncScheduleLoading
    ? { label: "Sync", status: "loading" as const, detail: "Checking scheduled knowledge sync." }
    : !syncSchedule
      ? { label: "Sync Off", status: "warning" as const, detail: "Scheduled knowledge sync is not configured." }
      : syncSchedule.enabled
        ? {
            label: "Sync On",
            status: syncSchedule.nextRunAt ? "success" as const : "warning" as const,
            detail: syncSchedule.nextRunAt
              ? `Scheduled knowledge sync is enabled. Next sync: ${formatDateTime(syncSchedule.nextRunAt)}.`
              : "Scheduled knowledge sync is enabled, but the next sync time is not available.",
          }
        : {
            label: "Sync Off",
            status: "warning" as const,
            detail: syncSchedule.lastEnqueuedAt
              ? `Scheduled knowledge sync is disabled. Last enqueued: ${formatDateTime(syncSchedule.lastEnqueuedAt)}.`
              : "Scheduled knowledge sync is disabled.",
          }

  // Proactive PAT health: only surfaced when there's a problem (expired/rejected
  // at use-time, or stale). A healthy PAT shows nothing extra here.
  const pat = credentials?.azurePat
  const patWarning =
    pat?.status === "expired" || pat?.status === "invalid"
      ? { label: "PAT Expired", detail: "Azure DevOps rejected your PAT. Re-enter it in Settings → My Credentials." }
      : pat?.isStale
        ? { label: "Check PAT", detail: "Your Azure DevOps PAT hasn't been validated in a while. Re-enter it in Settings → My Credentials." }
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

      <div className="flex min-w-[120px] flex-1 items-center gap-2 2xl:min-w-[400px]">
        <HeaderProjectSelector />
      </div>

      <div className="hidden min-w-0 items-center gap-1.5 xl:flex">
        <HeaderStatusChip {...azureStatus} />
        {patWarning ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <NavigationLink
                href="/settings"
                className={headerStatusChipClass("error", "max-w-36 transition-colors hover:bg-destructive/15")}
                aria-label={patWarning.detail}
              >
                <StatusChipContent label={patWarning.label} status="error" />
                <Settings2 className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
              </NavigationLink>
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-sm text-left">{patWarning.detail}</TooltipContent>
          </Tooltip>
        ) : null}
        <LlmModelChip
          status={llmStatus}
          provider={isProvider(llm?.provider) ? llm.provider : null}
          model={llm?.model ?? ""}
          disabled={credentialsLoading}
          onChanged={loadCredentials}
        />
        {syncScheduleVisible ? <HeaderStatusChip {...syncStatus} className="max-w-28" /> : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void loadProfile()
            void loadSession()
            void loadCredentials()
            void loadSyncSchedule()
          }}
          disabled={profileLoading || workspaceRoleLoading || credentialsLoading || syncScheduleLoading}
          aria-label="Refresh Azure DevOps, role, credential, and sync status"
          title="Refresh Azure DevOps, role, credential, and sync status"
        >
          <RefreshCw className={cn("size-3.5", (profileLoading || workspaceRoleLoading || credentialsLoading || syncScheduleLoading) && "animate-spin")} />
        </Button>
      </div>

      <ThemeToggle />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background/70 px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Open account menu${profile?.displayName ? ` for ${profile.displayName}` : ""}`}
          >
            <Avatar className="size-7">
              {profile?.imageUrl ? <AvatarImage src={profile.imageUrl} alt="" /> : null}
              <AvatarFallback className="bg-primary/10 text-primary">
                <UserRound className="size-4" aria-hidden="true" />
              </AvatarFallback>
            </Avatar>
            <div className="hidden min-w-0 sm:block">
              <div className="flex max-w-56 items-center gap-1.5">
                <span className="min-w-0 truncate text-sm font-medium">
                  {profile?.displayName ?? (profileError ? "Azure DevOps user unavailable" : "Loading Azure DevOps user")}
                </span>
                <RoleBadge role={workspaceRole} className="hidden md:inline-flex" />
              </div>
              {profile?.uniqueName ? <div className="max-w-48 truncate text-xs text-muted-foreground">{profile.uniqueName}</div> : null}
            </div>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="space-y-1">
            <span className="block truncate text-sm font-medium text-foreground">
              {profile?.displayName ?? (profileError ? "Azure DevOps user unavailable" : "Loading Azure DevOps user")}
            </span>
            {profile?.uniqueName ? <span className="block truncate font-normal">{profile.uniqueName}</span> : null}
            {workspaceRole ? (
              <span className="flex items-center gap-1.5 font-normal">
                <span className="text-muted-foreground">Role:</span>
                <RoleBadge role={workspaceRole} />
              </span>
            ) : workspaceRoleLoading ? (
              <span className="block truncate font-normal text-muted-foreground">Role: Checking</span>
            ) : null}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <NavigationLink href="/settings">
              <Settings2 className="size-4" />
              Settings
            </NavigationLink>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              handlePatDialogOpenChange(true)
            }}
          >
            <KeyRound className="size-4" />
            Replace access token
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={loggingOut}
            onSelect={(event) => {
              event.preventDefault()
              void handleLogout()
            }}
          >
            {loggingOut ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ReplacePatDialog
        open={patDialogOpen}
        onOpenChange={handlePatDialogOpenChange}
        azurePat={credentials?.azurePat ?? null}
        credentialsLoading={credentialsLoading}
        patInput={patInput}
        onPatInputChange={setPatInput}
        reveal={patReveal}
        onRevealChange={setPatReveal}
        saving={patSaving}
        onSubmit={handleReplacePat}
      />
    </header>
  )
}

function ReplacePatDialog({
  open,
  onOpenChange,
  azurePat,
  credentialsLoading,
  patInput,
  onPatInputChange,
  reveal,
  onRevealChange,
  saving,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  azurePat: CredentialSummary | null
  credentialsLoading: boolean
  patInput: string
  onPatInputChange: (value: string) => void
  reveal: boolean
  onRevealChange: (value: boolean) => void
  saving: boolean
  onSubmit: () => void
}) {
  const status = patDialogStatus(azurePat, credentialsLoading)
  const preview = azurePat?.maskedPreview ?? (status.key === "missing" ? "No saved token" : "Saved token hidden")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
          className="contents"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="size-4 text-primary" />
              Replace access token
            </DialogTitle>
            <DialogDescription>
              Validate a new Azure DevOps PAT and replace the saved token.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-muted-foreground">Current token</span>
              <span className={cn("rounded-[6px] border px-2 py-0.5 text-xs font-medium", status.className)}>
                {status.label}
              </span>
            </div>
            <div className="mt-2 truncate font-mono text-sm text-foreground">{preview}</div>
            {azurePat?.lastValidatedAt ? (
              <div className="mt-1 text-xs text-muted-foreground">
                Last validated {formatDateTime(azurePat.lastValidatedAt)}
              </div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-azure-pat">New personal access token</Label>
            <div className="relative">
              <Input
                id="profile-azure-pat"
                className="h-10 pr-10"
                type={reveal ? "text" : "password"}
                value={patInput}
                onChange={(event) => onPatInputChange(event.target.value)}
                placeholder="Enter Azure DevOps PAT"
                autoComplete="off"
                disabled={saving}
              />
              <button
                type="button"
                onClick={() => onRevealChange(!reveal)}
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                aria-label={reveal ? "Hide personal access token" : "Show personal access token"}
                disabled={saving}
              >
                {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !patInput.trim()}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Validate and replace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function patDialogStatus(summary: CredentialSummary | null, loading: boolean) {
  if (loading) {
    return {
      key: "checking",
      label: "Checking",
      className: "border-border bg-background text-muted-foreground",
    }
  }
  if (!summary || summary.status === "not_configured") {
    return {
      key: "missing",
      label: "Not configured",
      className: "border-border bg-background text-muted-foreground",
    }
  }
  if (summary.status === "invalid") {
    return {
      key: "invalid",
      label: "Invalid",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    }
  }
  if (summary.status === "expired") {
    return {
      key: "expired",
      label: "Expired",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    }
  }
  if (summary.isStale) {
    return {
      key: "stale",
      label: "Re-validate",
      className: "border-warning/40 bg-warning/15 text-warning-foreground dark:text-warning",
    }
  }
  return {
    key: "configured",
    label: "Configured",
    className: "border-success/30 bg-success/10 text-success",
  }
}

function HeaderStatusChip({
  label,
  detail,
  status,
  className,
}: {
  label: string
  detail: string
  status: HeaderStatus
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={headerStatusChipClass(status, className)} aria-label={detail}>
          <StatusChipContent label={label} status={status} />
        </span>
      </TooltipTrigger>
      <TooltipContent sideOffset={8} className="max-w-sm text-left">
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}

function StatusChipContent({ label, status }: { label: string; status: HeaderStatus }) {
  return (
    <>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "success" && "bg-success",
          status === "warning" && "bg-warning",
          status === "error" && "bg-destructive",
          (status === "neutral" || status === "loading") && "bg-muted-foreground",
          status === "loading" && "animate-pulse",
        )}
        aria-hidden="true"
      />
      <span className="truncate">{label}</span>
    </>
  )
}

function RoleBadge({ role, className = "" }: { role: WorkspaceRole | null; className?: string }) {
  if (!role) return null

  const styles = {
    owner: "border-primary/30 bg-primary/10 text-primary",
    admin: "border-info/30 bg-info/10 text-info",
    member: "border-border bg-muted text-muted-foreground",
  }[role]

  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-[6px] border px-1.5 text-[11px] font-medium leading-none",
        styles,
        className,
      )}
      title={`Workspace role: ${roleLabel(role)}`}
    >
      {roleLabel(role)}
    </span>
  )
}

function LlmModelChip({
  status,
  provider,
  model,
  disabled,
  onChanged,
}: {
  status: { label: string; detail: string; status: HeaderStatus }
  provider: Provider | null
  model: string
  disabled: boolean
  onChanged: () => void
}) {
  const configured = status.status === "success" && provider
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
            <NavigationLink
              href="/settings"
              className={headerStatusChipClass(status.status, "max-w-32 transition-colors hover:bg-muted")}
              aria-label={status.detail}
            >
              <StatusChipContent label={status.label} status={status.status} />
            </NavigationLink>
          </TooltipTrigger>
          <TooltipContent sideOffset={8} className="max-w-sm text-left">{status.detail}</TooltipContent>
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
      <PopoverTrigger asChild>
        <HeaderStatusChipButton
          label={status.label}
          status={status.status}
          detail={`${status.detail} Select to change the model.`}
          className="max-w-44"
          disabled={disabled}
          open={open}
          busy={loadingModels || Boolean(savingModel)}
        />
      </PopoverTrigger>
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
                    <NavigationLink href="/settings">Open settings</NavigationLink>
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

type HeaderStatusChipButtonProps = Omit<ComponentProps<"button">, "children"> & {
  label: string
  detail: string
  status: HeaderStatus
  open: boolean
  busy: boolean
}

const HeaderStatusChipButton = forwardRef<HTMLButtonElement, HeaderStatusChipButtonProps>(
  function HeaderStatusChipButton(
    { label, detail, status, disabled, open, busy, className, ...triggerProps },
    ref,
  ) {
  return (
    <button
      {...triggerProps}
      ref={ref}
      type="button"
      className={headerStatusChipClass(
        status,
        cn(
          "cursor-pointer transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60",
          className,
        ),
      )}
      disabled={disabled}
      aria-label={detail}
      title={detail}
    >
      <StatusChipContent label={label} status={status} />
      {busy ? (
        <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
      ) : (
        <ChevronDown
          className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      )}
    </button>
  )
  },
)

function headerStatusChipClass(status: HeaderStatus, className = "") {
  const styles = {
    success: "border-success/25 bg-success/5 text-foreground",
    warning: "border-warning/30 bg-warning/10 text-foreground",
    error: "border-destructive/25 bg-destructive/5 text-foreground",
    neutral: "border-border/80 bg-muted/40 text-muted-foreground",
    loading: "border-border/80 bg-muted/40 text-muted-foreground",
  }[status]

  return cn(
    "inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium leading-none",
    styles,
    className,
  )
}
