// @vitest-environment jsdom

import type { ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { RouteLoadingLifecycle } from "@/components/navigation/route-loading-state"
import {
  UnsavedChangesProvider,
  useNavigationFeedback,
  useUnsavedChangesGuard,
} from "@/components/navigation/unsaved-changes-provider"

const navigationMocks = vi.hoisted(() => ({
  pathname: "/dashboards",
  push: vi.fn(),
  replace: vi.fn(),
  router: null as null | { push: ReturnType<typeof vi.fn>; replace: ReturnType<typeof vi.fn> },
}))
navigationMocks.router = {
  push: navigationMocks.push,
  replace: navigationMocks.replace,
}

vi.mock("next/navigation", () => ({
  usePathname: () => navigationMocks.pathname,
  useRouter: () => navigationMocks.router,
}))

vi.mock("@/components/qa/confirmation-dialog", async () => {
  const React = await vi.importActual<typeof import("react")>("react")
  return {
    ConfirmationDialog: ({
      open,
      title,
      confirmLabel,
      onConfirm,
    }: {
      open?: boolean
      title: string
      confirmLabel?: string
      onConfirm: () => void
    }) => open
      ? React.createElement(
          "section",
          null,
          React.createElement("h2", null, title),
          React.createElement("button", { type: "button", onClick: onConfirm }, confirmLabel),
        )
      : null,
  }
})

function FeedbackReadout() {
  const { navigationPending, pendingHref } = useNavigationFeedback()
  return (
    <output data-testid="feedback">
      {navigationPending ? `pending:${pendingHref}` : "idle"}
    </output>
  )
}

function FeedbackLink({
  href,
  children,
  onClick,
}: {
  href: string
  children: ReactNode
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
}) {
  const { navigationPending, pendingHref } = useNavigationFeedback()
  return (
    <a
      href={href}
      onClick={onClick}
      aria-disabled={navigationPending || undefined}
      aria-busy={(navigationPending && pendingHref === href) || undefined}
    >
      {children}
    </a>
  )
}

function DirtyGuard() {
  useUnsavedChangesGuard({ dirty: true })
  return null
}

function TestApp({
  dirty = false,
  fallback = false,
  children,
}: {
  dirty?: boolean
  fallback?: boolean
  children?: ReactNode
}) {
  return (
    <UnsavedChangesProvider>
      {dirty ? <DirtyGuard /> : null}
      {fallback ? <RouteLoadingLifecycle /> : null}
      <FeedbackReadout />
      {children}
    </UnsavedChangesProvider>
  )
}

describe("UnsavedChangesProvider navigation feedback", () => {
  beforeEach(() => {
    navigationMocks.pathname = "/dashboards"
    navigationMocks.push.mockReset()
    navigationMocks.replace.mockReset()
    window.history.replaceState({}, "", "/dashboards")
  })

  afterEach(() => cleanup())

  it("starts one internal navigation, marks its link busy, and blocks additional clicks", () => {
    const settingsClick = vi.fn((event: React.MouseEvent) => event.preventDefault())
    const activityClick = vi.fn((event: React.MouseEvent) => event.preventDefault())

    render(
      <TestApp>
        <FeedbackLink href="/settings" onClick={settingsClick}>Settings</FeedbackLink>
        <FeedbackLink href="/activity-log" onClick={activityClick}>Activity log</FeedbackLink>
      </TestApp>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Settings" }))

    expect(screen.getByTestId("feedback")).toHaveTextContent("pending:/settings")
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-disabled", "true")
    expect(screen.getByRole("link", { name: "Activity log" })).toHaveAttribute("aria-disabled", "true")
    expect(settingsClick).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole("link", { name: "Activity log" }))
    expect(activityClick).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("link", { name: "Activity log" }), { ctrlKey: true })
    expect(activityClick).toHaveBeenCalledTimes(1)
  })

  it("ignores the current URL while preserving external and download links", () => {
    const currentClick = vi.fn((event: React.MouseEvent) => event.preventDefault())
    const externalClick = vi.fn((event: React.MouseEvent) => event.preventDefault())
    const downloadClick = vi.fn((event: React.MouseEvent) => event.preventDefault())

    render(
      <TestApp>
        <a href="/dashboards" onClick={currentClick}>Current page</a>
        <a href="https://example.com" onClick={externalClick}>External</a>
        <a href="/export.csv" download onClick={downloadClick}>Download</a>
      </TestApp>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Current page" }))
    expect(currentClick).not.toHaveBeenCalled()
    expect(screen.getByTestId("feedback")).toHaveTextContent("idle")

    fireEvent.click(screen.getByRole("link", { name: "External" }))
    fireEvent.click(screen.getByRole("link", { name: "Download" }))
    expect(externalClick).toHaveBeenCalledTimes(1)
    expect(downloadClick).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("feedback")).toHaveTextContent("idle")
  })

  it("waits for unsaved-work confirmation before entering the pending state", () => {
    render(
      <TestApp dirty>
        <FeedbackLink href="/settings">Settings</FeedbackLink>
      </TestApp>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Settings" }))

    expect(screen.getByRole("heading", { name: "Leave this page?" })).toBeInTheDocument()
    expect(screen.getByTestId("feedback")).toHaveTextContent("idle")
    expect(navigationMocks.push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Leave" }))

    expect(navigationMocks.push).toHaveBeenCalledWith("/settings")
    expect(screen.getByTestId("feedback")).toHaveTextContent("pending:/settings")
  })

  it("keeps navigation locked while a route fallback is mounted", async () => {
    const view = render(
      <TestApp>
        <FeedbackLink href="/settings" onClick={(event) => event.preventDefault()}>
          Settings
        </FeedbackLink>
      </TestApp>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Settings" }))
    navigationMocks.pathname = "/settings"
    view.rerender(
      <TestApp fallback>
        <FeedbackLink href="/settings">Settings</FeedbackLink>
      </TestApp>,
    )

    await waitFor(() => expect(screen.getByTestId("feedback")).toHaveTextContent("pending:/settings"))

    view.rerender(
      <TestApp>
        <FeedbackLink href="/settings">Settings</FeedbackLink>
      </TestApp>,
    )

    await waitFor(() => expect(screen.getByTestId("feedback")).toHaveTextContent("idle"))
  })

  it("releases a pre-navigation lock after the fail-safe timeout", () => {
    vi.useFakeTimers()
    render(
      <TestApp>
        <FeedbackLink href="/settings" onClick={(event) => event.preventDefault()}>
          Settings
        </FeedbackLink>
      </TestApp>,
    )

    fireEvent.click(screen.getByRole("link", { name: "Settings" }))
    expect(screen.getByTestId("feedback")).toHaveTextContent("pending:/settings")

    act(() => vi.advanceTimersByTime(15_000))

    expect(screen.getByTestId("feedback")).toHaveTextContent("idle")
  })
})
