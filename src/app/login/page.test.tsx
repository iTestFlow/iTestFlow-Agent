// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import LoginPage from "./page"

vi.mock("next/image", () => ({
  default: () => <span data-testid="login-brand-logo" />,
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const organizations = [
  { name: "Contoso", azureOrgName: "contoso", azureOrgUrl: "https://dev.azure.com/contoso" },
  { name: "Fabrikam", azureOrgName: "fabrikam", azureOrgUrl: "https://dev.azure.com/fabrikam" },
]

const jiraSites = [
  { name: "Quality", siteUrl: "https://quality.atlassian.net" },
  { name: "Platform", siteUrl: "https://platform.atlassian.net" },
]

const bothProviders = [
  { id: "azure-devops", label: "Azure DevOps" },
  { id: "jira-cloud", label: "Jira Cloud" },
]

const fetchMock = vi.fn()

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

type EndpointResult = Response | Promise<Response>
type Endpoint = EndpointResult | (() => EndpointResult)

// Routes fetches by URL so specs configure each endpoint independently; a
// function value is invoked per call (for failures followed by retries).
function mockApi(overrides: Partial<Record<"providers" | "organizations" | "sites" | "login", Endpoint>> = {}) {
  const endpoints: Record<string, Endpoint> = {
    "/api/auth/providers": overrides.providers ?? jsonResponse({ providers: bothProviders }),
    "/api/auth/organizations": overrides.organizations ?? jsonResponse({ organizations }),
    "/api/auth/jira/sites": overrides.sites ?? jsonResponse({ sites: [] }),
    "/api/auth/login": overrides.login ?? jsonResponse({ ok: true }),
  }
  fetchMock.mockImplementation(async (url: string) => {
    const endpoint = endpoints[url]
    if (!endpoint) throw new Error(`Unexpected fetch: ${url}`)
    // Responses are single-use; clone per call so repeated loads can re-read the body.
    const result = typeof endpoint === "function" ? endpoint() : endpoint
    const response = await result
    return response.clone()
  })
}

function callsTo(url: string) {
  return fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function renderLoginPage() {
  return render(
    <TooltipProvider>
      <LoginPage />
    </TooltipProvider>,
  )
}

describe("LoginPage", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    mockApi()
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    window.history.replaceState(null, "", "/login")
  })

  it("renders a provider chooser defaulting to Azure DevOps when both providers are enabled", async () => {
    renderLoginPage()

    const chooser = await screen.findByRole("group", { name: "Sign-in provider" })
    expect(chooser).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Azure DevOps" })).toHaveAttribute("aria-pressed", "true"),
    )
    expect(screen.getByRole("button", { name: "Jira Cloud" })).toHaveAttribute("aria-pressed", "false")

    // Azure pane is active: PAT form present, no Jira continue action.
    await screen.findByLabelText("Personal Access Token")
    expect(screen.queryByRole("button", { name: "Continue with Jira Cloud" })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Continue with Jira Cloud" })).not.toBeInTheDocument()
  })

  it("switches panes and preserves the entered PAT across switches", async () => {
    const user = userEvent.setup()
    mockApi({ sites: jsonResponse({ sites: [jiraSites[0]] }) })

    renderLoginPage()

    const patInput = await screen.findByLabelText("Personal Access Token")
    await user.type(patInput, "pat-secret")

    await user.click(screen.getByRole("button", { name: "Jira Cloud" }))
    expect(screen.queryByLabelText("Personal Access Token")).not.toBeInTheDocument()
    await screen.findByDisplayValue("Quality")

    await user.click(screen.getByRole("button", { name: "Azure DevOps" }))
    expect(await screen.findByLabelText("Personal Access Token")).toHaveValue("pat-secret")
  })

  it("skips the chooser and renders the Azure form directly when only Azure DevOps is enabled", async () => {
    mockApi({ providers: jsonResponse({ providers: [bothProviders[0]] }) })

    renderLoginPage()

    await screen.findByLabelText("Personal Access Token")
    expect(screen.queryByRole("group", { name: "Sign-in provider" })).not.toBeInTheDocument()
    expect(callsTo("/api/auth/jira/sites")).toHaveLength(0)
  })

  it("skips the chooser and renders the Jira pane directly when only Jira Cloud is enabled", async () => {
    mockApi({
      providers: jsonResponse({ providers: [bothProviders[1]] }),
      sites: jsonResponse({ sites: [jiraSites[0]] }),
    })

    renderLoginPage()

    await screen.findByDisplayValue("Quality")
    expect(screen.queryByRole("group", { name: "Sign-in provider" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Personal Access Token")).not.toBeInTheDocument()
    expect(callsTo("/api/auth/organizations")).toHaveLength(0)
  })

  it("shows a retryable error when sign-in options cannot be loaded", async () => {
    const user = userEvent.setup()
    let providerCalls = 0
    mockApi({
      providers: () => {
        providerCalls += 1
        return providerCalls === 1
          ? jsonResponse({ error: "Provider service unavailable." }, 503)
          : jsonResponse({ providers: bothProviders })
      },
    })

    renderLoginPage()

    expect(await screen.findByRole("alert")).toHaveTextContent("Provider service unavailable.")
    expect(screen.queryByRole("button", { name: "Sign In" })).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Retry" }))
    await screen.findByRole("group", { name: "Sign-in provider" })
  })

  it("shows a non-interactive loading state without a dropdown", async () => {
    const pending = deferred<Response>()
    mockApi({ organizations: pending.promise })

    renderLoginPage()

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Loading configured organizations"))
    expect(screen.queryByRole("combobox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()

    await act(async () => {
      pending.resolve(jsonResponse({ organizations }))
    })
    await screen.findByRole("combobox", { name: "Azure DevOps organization" })
  })

  it("displays and submits the only configured organization without a selection", async () => {
    const user = userEvent.setup()
    const [organization] = organizations
    mockApi({ organizations: jsonResponse({ organizations: [organization] }) })

    renderLoginPage()

    const organizationInput = await screen.findByDisplayValue("Contoso")
    expect(organizationInput).toHaveAttribute("readonly")
    expect(screen.getByLabelText("Azure DevOps organization")).toBe(organizationInput)
    expect(screen.queryByRole("combobox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText("Personal Access Token"), "pat-secret")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await waitFor(() => expect(callsTo("/api/auth/login")).toHaveLength(1))
    const [, request] = callsTo("/api/auth/login")[0]
    expect(JSON.parse((request as RequestInit).body as string)).toEqual({
      organization: "https://dev.azure.com/contoso",
      personalAccessToken: "pat-secret",
    })
  })

  it("renders a dropdown only when multiple organizations are configured", async () => {
    const user = userEvent.setup()

    renderLoginPage()

    await screen.findByRole("combobox", { name: "Azure DevOps organization" })
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()

    await user.type(screen.getByLabelText("Personal Access Token"), "pat-secret")
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()
  })

  it("shows administrator guidance instead of an organization input when none are configured", async () => {
    mockApi({ organizations: jsonResponse({ organizations: [] }) })

    renderLoginPage()

    await screen.findByText("No Azure DevOps organization is configured.")
    expect(screen.queryByRole("combobox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()
    expect(screen.queryByRole("textbox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "How to add an Azure DevOps organization" })).toBeInTheDocument()
  })

  it("retries a failed organization request and preserves the entered PAT", async () => {
    const user = userEvent.setup()
    const pending = deferred<Response>()
    const [organization] = organizations
    let organizationCalls = 0
    mockApi({
      organizations: () => {
        organizationCalls += 1
        return organizationCalls === 1
          ? jsonResponse({ error: "Organization service is temporarily unavailable." }, 503)
          : pending.promise
      },
    })

    renderLoginPage()

    expect(await screen.findByRole("alert")).toHaveTextContent("Organization service is temporarily unavailable.")
    expect(screen.queryByRole("combobox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()

    const patInput = screen.getByLabelText("Personal Access Token")
    await user.type(patInput, "pat-secret")
    await user.click(screen.getByRole("button", { name: "Retry" }))

    expect(screen.getByRole("status")).toHaveTextContent("Loading configured organizations")
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()

    await act(async () => {
      pending.resolve(jsonResponse({ organizations: [organization] }))
    })
    await screen.findByDisplayValue("Contoso")

    expect(patInput).toHaveValue("pat-secret")
    expect(callsTo("/api/auth/organizations")).toHaveLength(2)
    expect(callsTo("/api/auth/providers")).toHaveLength(1)
  })

  it("explains how to configure an organization from the organization field", async () => {
    renderLoginPage()

    await screen.findByRole("combobox", { name: "Azure DevOps organization" })

    const helpButton = screen.getByRole("button", { name: "How to add an Azure DevOps organization" })
    fireEvent.focus(helpButton)

    expect(helpButton).toHaveAttribute("aria-describedby")
    expect((await screen.findAllByText(/Organizations are configured by your iTestFlow administrator/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText("BOOTSTRAP_AZURE_ORGS").length).toBeGreaterThan(0)
    expect(screen.getAllByText(".env").length).toBeGreaterThan(0)
    expect(screen.getAllByText("orgUrl|ownerEmail").length).toBeGreaterThan(0)
  })

  it("shows the Jira loading state, then guidance naming BOOTSTRAP_JIRA_SITES when no sites are configured", async () => {
    const user = userEvent.setup()
    const pending = deferred<Response>()
    mockApi({ sites: pending.promise })

    renderLoginPage()

    await screen.findByRole("group", { name: "Sign-in provider" })
    await user.click(screen.getByRole("button", { name: "Jira Cloud" }))

    expect(screen.getByRole("status")).toHaveTextContent("Loading configured Jira sites")
    expect(screen.getByRole("button", { name: "Continue with Jira Cloud" })).toBeDisabled()

    await act(async () => {
      pending.resolve(jsonResponse({ sites: [] }))
    })
    await screen.findByText("No Jira Cloud site is configured.")
    expect(screen.getByRole("button", { name: "Continue with Jira Cloud" })).toBeDisabled()
    expect(screen.getByText("BOOTSTRAP_JIRA_SITES")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "How to add a Jira Cloud site" })).toBeInTheDocument()
  })

  it("retries a failed Jira site request without refetching providers", async () => {
    const user = userEvent.setup()
    let siteCalls = 0
    mockApi({
      providers: jsonResponse({ providers: [bothProviders[1]] }),
      sites: () => {
        siteCalls += 1
        return siteCalls === 1
          ? jsonResponse({ error: "Site service unavailable." }, 503)
          : jsonResponse({ sites: [jiraSites[0]] })
      },
    })

    renderLoginPage()

    expect(await screen.findByRole("alert")).toHaveTextContent("Site service unavailable.")
    await user.click(screen.getByRole("button", { name: "Retry" }))

    await screen.findByDisplayValue("Quality")
    expect(callsTo("/api/auth/jira/sites")).toHaveLength(2)
    expect(callsTo("/api/auth/providers")).toHaveLength(1)
  })

  it("auto-selects a single Jira site and links to the site-scoped OAuth start", async () => {
    mockApi({
      providers: jsonResponse({ providers: [bothProviders[1]] }),
      sites: jsonResponse({ sites: [jiraSites[0]] }),
    })

    renderLoginPage()

    const siteInput = await screen.findByDisplayValue("Quality")
    expect(siteInput).toHaveAttribute("readonly")
    expect(screen.getByLabelText("Jira Cloud site")).toBe(siteInput)

    const continueLink = screen.getByRole("link", { name: "Continue with Jira Cloud" })
    expect(continueLink).toHaveAttribute(
      "href",
      `/api/auth/jira/start?site=${encodeURIComponent("https://quality.atlassian.net")}&returnTo=%2Fdashboards`,
    )
  })

  it("renders a site dropdown for multiple Jira sites and disables Continue until one is chosen", async () => {
    mockApi({
      providers: jsonResponse({ providers: [bothProviders[1]] }),
      sites: jsonResponse({ sites: jiraSites }),
    })

    renderLoginPage()

    await screen.findByRole("combobox", { name: "Jira Cloud site" })
    expect(screen.getByRole("button", { name: "Continue with Jira Cloud" })).toBeDisabled()
    expect(screen.queryByRole("link", { name: "Continue with Jira Cloud" })).not.toBeInTheDocument()
  })

  it("carries a safe ?next= into the Jira OAuth start link and falls back for unsafe values", async () => {
    mockApi({
      providers: jsonResponse({ providers: [bothProviders[1]] }),
      sites: jsonResponse({ sites: [jiraSites[0]] }),
    })

    window.history.replaceState(null, "", "/login?next=%2Fsettings")
    renderLoginPage()
    expect(await screen.findByRole("link", { name: "Continue with Jira Cloud" })).toHaveAttribute(
      "href",
      `/api/auth/jira/start?site=${encodeURIComponent("https://quality.atlassian.net")}&returnTo=%2Fsettings`,
    )

    cleanup()
    window.history.replaceState(null, "", "/login?next=https%3A%2F%2Fevil.example")
    renderLoginPage()
    expect(await screen.findByRole("link", { name: "Continue with Jira Cloud" })).toHaveAttribute(
      "href",
      `/api/auth/jira/start?site=${encodeURIComponent("https://quality.atlassian.net")}&returnTo=%2Fdashboards`,
    )
  })

  it("surfaces a Jira site-access bounce on the Jira pane, naming only a deployment-listed site", async () => {
    mockApi({ sites: jsonResponse({ sites: [jiraSites[0]] }) })

    window.history.replaceState(
      null,
      "",
      `/login?error=jira_site_access&site=${encodeURIComponent("https://quality.atlassian.net")}`,
    )
    renderLoginPage()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Jira site access was denied.")
    // The named variant appears once the deployment's site list resolves.
    await waitFor(() => expect(alert).toHaveTextContent("Quality (https://quality.atlassian.net)"))
    // The Jira pane is pre-selected so the user can act immediately.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Jira Cloud" })).toHaveAttribute("aria-pressed", "true"),
    )
    expect(screen.queryByLabelText("Personal Access Token")).not.toBeInTheDocument()

    cleanup()
    window.history.replaceState(
      null,
      "",
      `/login?error=jira_site_access&site=${encodeURIComponent("https://unlisted.atlassian.net")}`,
    )
    renderLoginPage()

    const genericAlert = await screen.findByRole("alert")
    expect(genericAlert).toHaveTextContent("Your Atlassian account does not have access to the selected Jira site.")
    expect(genericAlert).not.toHaveTextContent("unlisted")
  })
})
