"use client"

import { useCallback, useEffect, useState } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import {
  Building2,
  CircleHelp,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  Loader2,
  LockKeyhole,
  RefreshCw,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Callout } from "@/components/qa/callout"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { resolveLoginDestination } from "@/app/login/login-destination"
import { apiErrorMessage, caughtErrorMessage } from "@/shared/lib/api-error-message"

type OrganizationOption = {
  name: string
  azureOrgName: string
  azureOrgUrl: string
}

type OrganizationLoadState = "loading" | "ready" | "error"

type OrganizationListResponse = {
  organizations?: OrganizationOption[]
}

const azurePatHelpUrl =
  "https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate?view=azure-devops"

function LoginBrandLogo() {
  return (
    <Image
      src="/brand/itestflow-logo-full.png"
      alt="iTestFlow - AI-Powered Software Testing Lifecycle"
      width={1554}
      height={346}
      priority
      className="h-auto w-[min(460px,90vw)] max-w-full"
    />
  )
}

function LoginBackgroundFlow() {
  return (
    <svg
      aria-hidden="true"
      className="absolute inset-0 -z-10 h-full w-full"
      preserveAspectRatio="xMidYMid slice"
      viewBox="0 0 1440 900"
    >
      <defs>
        <pattern id="login-dot-pattern" width="18" height="18" patternUnits="userSpaceOnUse">
          <circle cx="1.5" cy="1.5" r="1.5" fill="hsl(var(--primary))" opacity="0.18" />
        </pattern>
      </defs>
      <rect x="1085" y="44" width="310" height="380" fill="url(#login-dot-pattern)" opacity="0.22" />
      <path
        d="M1132 -70C1078 22 1115 87 1192 104C1276 122 1308 181 1270 244C1214 337 1325 361 1392 346C1453 333 1496 364 1518 416"
        fill="none"
        stroke="hsl(var(--primary))"
        strokeLinecap="round"
        strokeWidth="3"
        opacity="0.13"
      />
      <path
        d="M1092 392C1019 421 1003 493 1048 550C1098 614 1072 682 1004 713C932 745 910 817 956 910"
        fill="none"
        stroke="hsl(var(--primary))"
        strokeLinecap="round"
        strokeWidth="3"
        opacity="0.13"
      />
      <path
        d="M-90 466C-10 475 54 518 45 590C36 662 106 666 126 726C145 785 88 815 115 906"
        fill="none"
        stroke="hsl(var(--info))"
        strokeLinecap="round"
        strokeWidth="3"
        opacity="0.12"
      />
      {[
        [1160, 105, 20, "primary"],
        [1300, 245, 14, "success"],
        [1252, 412, 17, "primary"],
        [1088, 608, 14, "success"],
        [92, 566, 13, "info"],
        [130, 726, 14, "success"],
        [112, 836, 15, "primary"],
      ].map(([cx, cy, r, color]) => (
        <g key={`${cx}-${cy}`}>
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="hsl(var(--background))"
            stroke={`hsl(var(--${color}))`}
            strokeWidth="3"
            opacity="0.18"
          />
          <circle cx={cx} cy={cy} r={Number(r) / 2.2} fill={`hsl(var(--${color}))`} opacity="0.1" />
        </g>
      ))}
    </svg>
  )
}

function OrganizationConfigurationHelp() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="How to add an Azure DevOps organization"
          className="grid size-10 shrink-0 place-items-center rounded-lg border border-input bg-background/80 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-sm whitespace-normal text-left leading-5">
        <span>
          Organizations are configured by your iTestFlow administrator. To add one, update{" "}
          <code className="rounded bg-background/15 px-1 font-mono text-[11px]">BOOTSTRAP_AZURE_ORGS</code> in the
          server&apos;s <code className="rounded bg-background/15 px-1 font-mono text-[11px]">.env</code> file with an{" "}
          <code className="rounded bg-background/15 px-1 font-mono text-[11px]">orgUrl|ownerEmail</code> entry, then
          restart iTestFlow. Example: <code className="rounded bg-background/15 px-1 font-mono text-[11px]">https://dev.azure.com/new-org|owner@company.com</code>.
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

export default function LoginPage() {
  const router = useRouter()
  const [organization, setOrganization] = useState("")
  const [personalAccessToken, setPersonalAccessToken] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [showPersonalAccessToken, setShowPersonalAccessToken] = useState(false)
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([])
  const [organizationLoadState, setOrganizationLoadState] = useState<OrganizationLoadState>("loading")
  const [organizationLoadError, setOrganizationLoadError] = useState("")

  const loadOrganizations = useCallback(async (signal?: AbortSignal) => {
    setOrganizationLoadState("loading")
    setOrganizationLoadError("")
    setOrganizations([])
    setOrganization("")

    try {
      const response = await fetch("/api/auth/organizations", { cache: "no-store", signal })
      const data = (await response.json().catch(() => null)) as OrganizationListResponse | null
      if (signal?.aborted) return

      if (!response.ok) {
        throw new Error(apiErrorMessage(data, "Unable to load configured organizations."))
      }
      if (!Array.isArray(data?.organizations)) {
        throw new Error("Unable to load configured organizations.")
      }

      const list = data.organizations
      setOrganizations(list)
      // Submit the canonical URL while showing the friendly workspace name for a
      // single configured organization.
      setOrganization(list.length === 1 ? list[0].azureOrgUrl : "")
      setOrganizationLoadState("ready")
    } catch (error) {
      if (signal?.aborted) return
      setOrganizationLoadError(caughtErrorMessage(error, "Unable to load configured organizations."))
      setOrganizationLoadState("error")
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void loadOrganizations(controller.signal)
    return () => {
      controller.abort()
    }
  }, [loadOrganizations])

  const singleOrganization =
    organizationLoadState === "ready" && organizations.length === 1 ? organizations[0] : null
  const signInDisabled =
    submitting || organizationLoadState !== "ready" || organizations.length === 0 || !organization.trim()

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!organization.trim()) {
      toast.error("Select your Azure DevOps organization.")
      return
    }
    setSubmitting(true)
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organization, personalAccessToken }),
      })
      const data = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast.error(apiErrorMessage(data, "Sign in failed."))
        return
      }
      toast.success("Signed in.")
      // Return the user to where the session-expiry redirect sent them from, if it's
      // a safe in-app path; otherwise land directly on the dashboard.
      const nextParam = new URLSearchParams(window.location.search).get("next")
      router.push(resolveLoginDestination(nextParam))
      router.refresh()
    } catch {
      toast.error("Sign in failed. Check your connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative isolate flex min-h-screen w-full items-center justify-center overflow-hidden bg-[linear-gradient(135deg,hsl(var(--background))_0%,hsl(var(--accent)/0.62)_48%,hsl(var(--background))_100%)] px-4 py-8 text-foreground sm:px-6 dark:bg-[linear-gradient(135deg,hsl(var(--background))_0%,hsl(var(--accent)/0.24)_48%,hsl(var(--background))_100%)]">
      <div className="absolute inset-x-0 top-[7%] -z-10 mx-auto h-[30rem] max-w-[44rem] rounded-full bg-[radial-gradient(circle,hsl(var(--info)/0.13)_0%,hsl(var(--primary)/0.1)_36%,transparent_72%)] blur-3xl dark:bg-[radial-gradient(circle,hsl(var(--info)/0.14)_0%,hsl(var(--primary)/0.12)_34%,transparent_72%)]" />
      <LoginBackgroundFlow />

      <div className="flex w-full min-w-0 max-w-[640px] flex-col items-center gap-6">
        <LoginBrandLogo />

        <Card className="w-full min-w-0 max-w-full gap-5 rounded-xl bg-card/95 py-6 shadow-card ring-border/80 backdrop-blur dark:bg-card/90 dark:shadow-card-dark dark:ring-border/70">
          <CardHeader className="gap-2 px-5 sm:px-8">
            <CardTitle className="text-xl font-semibold leading-tight">Sign in to iTestFlow</CardTitle>
            <CardDescription className="max-w-[520px] leading-6">
              Connect iTestFlow to your Azure DevOps organization using a Personal Access Token. Your token is validated
              securely and stored encrypted in this private deployment.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-5 sm:px-8">
            <form className="space-y-5" onSubmit={onSubmit}>
              <div className="space-y-2">
                {organizationLoadState === "loading" || organizationLoadState === "error" || organizations.length === 0 ? (
                  <p className="text-sm font-medium leading-none">Azure DevOps organization</p>
                ) : (
                  <Label htmlFor="organization">Azure DevOps organization</Label>
                )}
                {organizationLoadState === "loading" ? (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <div
                        className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-lg border border-input bg-muted/30 px-3 text-sm text-muted-foreground"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                      >
                        <Loader2
                          className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                        <span>Loading configured organizations…</span>
                      </div>
                      <OrganizationConfigurationHelp />
                    </div>
                    <p className="text-xs leading-5 text-muted-foreground">
                      Checking this deployment&apos;s organization configuration.
                    </p>
                  </>
                ) : organizationLoadState === "error" ? (
                  <Callout
                    tone="error"
                    role="alert"
                    title="Unable to load organizations."
                    action={
                      <Button type="button" variant="outline" size="sm" onClick={() => void loadOrganizations()}>
                        <RefreshCw className="size-3.5" aria-hidden="true" />
                        Retry
                      </Button>
                    }
                  >
                    {organizationLoadError}
                  </Callout>
                ) : organizations.length === 0 ? (
                  <Callout
                    tone="warning"
                    role="status"
                    title="No Azure DevOps organization is configured."
                    action={<OrganizationConfigurationHelp />}
                  >
                    Ask your iTestFlow administrator to configure <code>BOOTSTRAP_AZURE_ORGS</code> and restart iTestFlow.
                  </Callout>
                ) : singleOrganization ? (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Building2
                          className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-primary"
                          aria-hidden="true"
                        />
                        <Input
                          id="organization"
                          className="h-10 bg-muted/30 pl-11 pr-3 text-foreground"
                          value={singleOrganization.name}
                          readOnly
                          aria-describedby="organization-help"
                        />
                      </div>
                      <OrganizationConfigurationHelp />
                    </div>
                    <p id="organization-help" className="text-xs leading-5 text-muted-foreground">
                      This is the only organization configured for this deployment.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="relative min-w-0 flex-1">
                        <Building2
                          className="pointer-events-none absolute left-4 top-1/2 z-10 size-5 -translate-y-1/2 text-primary"
                          aria-hidden="true"
                        />
                        <Select
                          value={organization}
                          onValueChange={setOrganization}
                          disabled={submitting}
                        >
                          <SelectTrigger
                            id="organization"
                            className="h-10 w-full bg-background/80 pl-11 pr-3"
                            aria-describedby="organization-help"
                          >
                            <SelectValue placeholder="Select your organization" />
                          </SelectTrigger>
                          <SelectContent>
                            {organizations.map((org) => (
                              <SelectItem key={org.azureOrgUrl} value={org.azureOrgUrl}>
                                {org.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <OrganizationConfigurationHelp />
                    </div>
                    <p id="organization-help" className="text-xs leading-5 text-muted-foreground">
                      Choose the organization you want to sign in to.
                    </p>
                  </>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="pat">Personal Access Token</Label>
                <div className="relative">
                  <LockKeyhole
                    className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <Input
                    id="pat"
                    className="h-10 bg-background/80 pl-11 pr-11"
                    type={showPersonalAccessToken ? "text" : "password"}
                    placeholder="Azure DevOps PAT"
                    value={personalAccessToken}
                    onChange={(event) => setPersonalAccessToken(event.target.value)}
                    autoComplete="off"
                    aria-describedby="pat-help"
                    required
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    onClick={() => setShowPersonalAccessToken((current) => !current)}
                    aria-label={showPersonalAccessToken ? "Hide Personal Access Token" : "Show Personal Access Token"}
                    aria-pressed={showPersonalAccessToken}
                  >
                    {showPersonalAccessToken ? (
                      <Eye className="size-4" aria-hidden="true" />
                    ) : (
                      <EyeOff className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <p id="pat-help" className="text-xs leading-5 text-muted-foreground">
                  Use a PAT with access to Work Items, Test Plans, and Project metadata.
                </p>
                <a
                  href={azurePatHelpUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary outline-none transition-colors hover:text-primary/80 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                >
                  <CircleHelp className="size-4" aria-hidden="true" />
                  How to create an Azure DevOps PAT
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </div>

              <div className="pt-1">
                <Button type="submit" size="lg" className="h-10 w-full font-semibold" disabled={signInDisabled}>
                  {submitting ? "Signing in..." : "Sign In"}
                </Button>
              </div>
            </form>
            <div className="my-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wide text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>
            <Button asChild type="button" variant="outline" size="lg" className="h-10 w-full font-semibold">
              <a href="/api/auth/jira/start?returnTo=%2Fdashboards">Continue with Jira Cloud</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
