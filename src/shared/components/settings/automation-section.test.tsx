// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const hookMocks = vi.hoisted(() => ({
  useActiveProject: vi.fn(),
  useProjectWorkItemMetadata: vi.fn(),
}))
vi.mock("@/shared/lib/use-active-project", () => ({ useActiveProject: hookMocks.useActiveProject }))
vi.mock("@/shared/lib/use-project-work-item-metadata", () => ({ useProjectWorkItemMetadata: hookMocks.useProjectWorkItemMetadata }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { toast } from "sonner"
import { AutomationSection } from "./automation-section"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
}

function mockApi(overrides: Partial<Record<"session" | "schedule" | "sync", () => Response>> = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === "/api/auth/session") {
      return (overrides.session ?? (() => jsonResponse({ workspace: { providerId: "azure-devops" } })))()
    }
    if (url === "/api/workspace/sync-schedule") {
      return (overrides.schedule ?? (() => jsonResponse({ workspaceId: "ws-1", schedule: null })))()
    }
    if (url === "/api/workspace/sync") {
      return (overrides.sync ?? (() => jsonResponse({ ok: true, workspaceId: "ws-1", enqueued: 2 })))()
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })
}

function putCall() {
  return fetchMock.mock.calls.find(
    ([url, init]) => url === "/api/workspace/sync-schedule" && (init as RequestInit | undefined)?.method === "PUT",
  )
}

describe("AutomationSection", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    mockApi()
    vi.stubGlobal("fetch", fetchMock)
    hookMocks.useActiveProject.mockReturnValue(null)
    hookMocks.useProjectWorkItemMetadata.mockReturnValue({ metadata: null, loading: false, error: null, retry: vi.fn() })
    vi.mocked(toast.success).mockClear()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("keeps the Azure work-item filters and requires them for an Azure workspace", async () => {
    render(<AutomationSection />)
    await screen.findByText("Work item types")
    expect(screen.getByText("States")).toBeInTheDocument()
    expect(screen.getByText(/Azure DevOps context/)).toBeInTheDocument()
  })

  it("hides the Azure-only filters for a Jira workspace, skips their metadata, and saves without them", async () => {
    const user = userEvent.setup()
    mockApi({ session: () => jsonResponse({ workspace: { providerId: "jira-cloud" } }) })

    render(<AutomationSection />)

    await screen.findByText(/Jira project context/)
    expect(screen.queryByText("Work item types")).not.toBeInTheDocument()
    // The metadata hook never receives a scope, so no Azure metadata request can fire.
    for (const [scope] of hookMocks.useProjectWorkItemMetadata.mock.calls) expect(scope).toBeNull()

    await waitFor(() => expect(screen.getByRole("button", { name: "Save schedule" })).toBeEnabled())
    await user.click(screen.getByRole("button", { name: "Save schedule" }))
    await waitFor(() => expect(putCall()).toBeTruthy())
    expect(JSON.parse(String((putCall()![1] as RequestInit).body))).toMatchObject({ workItemTypes: [], states: [] })
  })

  it("starts an on-demand workspace sync for any provider from the Sync now control", async () => {
    const user = userEvent.setup()
    const scheduleChanged = vi.fn()
    window.addEventListener("itestflow:sync-schedule-changed", scheduleChanged)

    render(<AutomationSection />)

    const syncNow = await screen.findByRole("button", { name: "Sync now" })
    await waitFor(() => expect(syncNow).toBeEnabled())
    await user.click(syncNow)

    await waitFor(() => expect(fetchMock.mock.calls.some(
      ([url, init]) => url === "/api/workspace/sync" && (init as RequestInit | undefined)?.method === "POST",
    )).toBe(true))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Workspace sync started for 2 projects."))
    expect(scheduleChanged).toHaveBeenCalled()
    window.removeEventListener("itestflow:sync-schedule-changed", scheduleChanged)
  })

  it("renders a persistent actionable alert when no sync worker is available", async () => {
    const user = userEvent.setup()
    mockApi({
      sync: () => jsonResponse(
        { error: "Workspace sync is temporarily unavailable.", code: "workspace_sync_unavailable" },
        503,
        { "Retry-After": "5" },
      ),
    })

    render(<AutomationSection />)

    const syncNow = await screen.findByRole("button", { name: "Sync now" })
    await waitFor(() => expect(syncNow).toBeEnabled())
    await user.click(syncNow)

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("retry in 5s")
    expect(alert).toHaveTextContent("Start the worker process")
  })
})
