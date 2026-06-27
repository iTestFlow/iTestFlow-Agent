"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import {
  Building2,
  CircleHelp,
  ExternalLink,
  Eye,
  EyeOff,
  LockKeyhole,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
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

type OrganizationOption = {
  name: string
  azureOrgName: string
  azureOrgUrl: string
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

export default function LoginPage() {
  const router = useRouter()
  const [organization, setOrganization] = useState("")
  const [personalAccessToken, setPersonalAccessToken] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [showPersonalAccessToken, setShowPersonalAccessToken] = useState(false)
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([])
  const [orgsLoading, setOrgsLoading] = useState(true)
  // When the org list can't be loaded (fetch error) or is empty (fresh deploy
  // before bootstrap), fall back to a free-text field so sign-in is never blocked.
  const [orgsFallback, setOrgsFallback] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch("/api/auth/organizations", { cache: "no-store" })
        const data = (await response.json().catch(() => ({}))) as { organizations?: OrganizationOption[] }
        if (cancelled) return
        const list = response.ok && Array.isArray(data.organizations) ? data.organizations : []
        setOrganizations(list)
        setOrgsFallback(list.length === 0)
        // Preselect when the deployment enables exactly one org.
        if (list.length === 1) setOrganization(list[0].azureOrgUrl)
      } catch {
        if (!cancelled) setOrgsFallback(true)
      } finally {
        if (!cancelled) setOrgsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
        toast.error(data.error ?? "Sign in failed.")
        return
      }
      toast.success("Signed in.")
      // Return the user to where the session-expiry redirect sent them from, if it's
      // a safe in-app path; otherwise land on the home route.
      const nextParam = new URLSearchParams(window.location.search).get("next")
      const destination = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/"
      router.push(destination)
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
                <Label htmlFor="organization">Azure DevOps organization</Label>
                {orgsFallback ? (
                  <>
                    <div className="relative">
                      <Building2
                        className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-primary"
                        aria-hidden="true"
                      />
                      <Input
                        id="organization"
                        className="h-10 bg-background/80 pl-11 pr-3 placeholder:text-[13px] sm:placeholder:text-sm"
                        placeholder="contoso or https://dev.azure.com/contoso"
                        value={organization}
                        onChange={(event) => setOrganization(event.target.value)}
                        autoCapitalize="none"
                        autoComplete="organization"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-describedby="organization-help"
                        required
                      />
                    </div>
                    <p id="organization-help" className="text-xs leading-5 text-muted-foreground">
                      Enter your organization name or full Azure DevOps URL.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="relative">
                      <Building2
                        className="pointer-events-none absolute left-4 top-1/2 z-10 size-5 -translate-y-1/2 text-primary"
                        aria-hidden="true"
                      />
                      <Select
                        value={organization}
                        onValueChange={setOrganization}
                        disabled={orgsLoading || submitting}
                      >
                        <SelectTrigger
                          id="organization"
                          className="h-10 w-full bg-background/80 pl-11 pr-3"
                          aria-describedby="organization-help"
                        >
                          <SelectValue
                            placeholder={orgsLoading ? "Loading organizations…" : "Select your organization"}
                          />
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
                <Button type="submit" size="lg" className="h-10 w-full font-semibold" disabled={submitting}>
                  {submitting ? "Signing in..." : "Sign In"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
