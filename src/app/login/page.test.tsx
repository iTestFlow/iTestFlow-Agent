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

const fetchMock = vi.fn()

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function organizationResponse(list: typeof organizations, status = 200) {
  return new Response(JSON.stringify({ organizations: list }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
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
    fetchMock.mockResolvedValue(organizationResponse(organizations))
    vi.stubGlobal("ResizeObserver", ResizeObserverMock)
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("offers the browser-bound Jira Cloud OAuth flow", () => {
    renderLoginPage()
    expect(screen.getByRole("link", { name: "Continue with Jira Cloud" })).toHaveAttribute(
      "href",
      "/api/auth/jira/start?returnTo=%2Fdashboards",
    )
  })

  it("shows a non-interactive loading state without a dropdown", async () => {
    const pending = deferred<Response>()
    fetchMock.mockReset()
    fetchMock.mockReturnValueOnce(pending.promise)

    renderLoginPage()

    expect(screen.getByRole("status")).toHaveTextContent("Loading configured organizations")
    expect(screen.queryByRole("combobox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Sign In" })).toBeDisabled()

    await act(async () => {
      pending.resolve(organizationResponse(organizations))
    })
    await screen.findByRole("combobox", { name: "Azure DevOps organization" })
  })

  it("displays and submits the only configured organization without a selection", async () => {
    const user = userEvent.setup()
    const [organization] = organizations
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(organizationResponse([organization]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } }))

    renderLoginPage()

    const organizationInput = await screen.findByDisplayValue("Contoso")
    expect(organizationInput).toHaveAttribute("readonly")
    expect(screen.getByLabelText("Azure DevOps organization")).toBe(organizationInput)
    expect(screen.queryByRole("combobox", { name: "Azure DevOps organization" })).not.toBeInTheDocument()

    await user.type(screen.getByLabelText("Personal Access Token"), "pat-secret")
    await user.click(screen.getByRole("button", { name: "Sign In" }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [, request] = fetchMock.mock.calls[1]
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/login")
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
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(organizationResponse([]))

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
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Organization service is temporarily unavailable." }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockReturnValueOnce(pending.promise)

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
      pending.resolve(organizationResponse([organization]))
    })
    await screen.findByDisplayValue("Contoso")

    expect(patInput).toHaveValue("pat-secret")
    expect(fetchMock).toHaveBeenCalledTimes(2)
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
})
