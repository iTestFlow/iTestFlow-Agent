"use client"

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react"
import { usePathname, useRouter } from "next/navigation"

import { ConfirmationDialog } from "@/components/qa/confirmation-dialog"

type GuardState = {
  dirty: boolean
  busy: boolean
}

type NavigationDestinationLike = {
  url: string
  key?: string
}

type NavigateEventLike = Event & {
  canIntercept: boolean
  destination: NavigationDestinationLike
  downloadRequest: string | null
  hashChange: boolean
  navigationType: "push" | "reload" | "replace" | "traverse"
}

type NavigationLike = EventTarget & {
  navigate: (url: string, options?: { history?: "auto" | "push" | "replace" }) => unknown
  traverseTo: (key: string) => unknown
}

type GuardContextValue = {
  register: (id: string, state: GuardState) => void
  unregister: (id: string) => void
  confirmAction: (action: () => void) => void
  navigate: (href: string, options?: { replace?: boolean }) => void
  navigationPending: boolean
  pendingHref: string | null
  registerRouteFallback: () => () => void
}

const GuardContext = createContext<GuardContextValue | null>(null)
const HISTORY_POINT_KEY = "__itestflowNavigationPoint"
const NAVIGATION_FAILSAFE_MS = 15_000

type PendingNavigation = {
  href: string
  startedAt: number
}

type AnchorNavigation = {
  destination: URL
  href: string
  exactCurrentUrl: boolean
  hashOnly: boolean
}

function currentRelativeUrl() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

function historyStateWithPoint(data: unknown, point: number) {
  const state = data && typeof data === "object" ? data : {}
  return { ...state, [HISTORY_POINT_KEY]: point }
}

function isModifiedClick(event: MouseEvent) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
}

function getAnchorNavigation(anchor: HTMLAnchorElement): AnchorNavigation | null {
  if (anchor.target && anchor.target.toLowerCase() !== "_self") return null
  if (anchor.hasAttribute("download")) return null
  if (!anchor.href) return null

  const destination = new URL(anchor.href, window.location.href)
  if (destination.origin !== window.location.origin) return null

  const current = new URL(window.location.href)
  const hashOnly =
    destination.pathname === current.pathname &&
    destination.search === current.search &&
    destination.hash !== current.hash

  return {
    destination,
    href: `${destination.pathname}${destination.search}${destination.hash}`,
    exactCurrentUrl: destination.href === current.href,
    hashOnly,
  }
}

function stopNavigationEvent(event: Event) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [registrations, setRegistrations] = useState<Map<string, GuardState>>(() => new Map())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null)
  const pendingActionRef = useRef<(() => void) | null>(null)
  const pendingNavigationRef = useRef<PendingNavigation | null>(null)
  const activeFallbacksRef = useRef(0)
  const committedPathnameRef = useRef(pathname)
  const allowNextNavigationRef = useRef(false)
  const blockedRef = useRef(false)

  const hasUnfinishedWork = useMemo(
    () => [...registrations.values()].some((state) => state.dirty || state.busy),
    [registrations],
  )
  blockedRef.current = hasUnfinishedWork

  const register = useCallback((id: string, state: GuardState) => {
    setRegistrations((current) => {
      const previous = current.get(id)
      if (previous?.dirty === state.dirty && previous.busy === state.busy) return current
      const next = new Map(current)
      next.set(id, state)
      return next
    })
  }, [])

  const unregister = useCallback((id: string) => {
    setRegistrations((current) => {
      if (!current.has(id)) return current
      const next = new Map(current)
      next.delete(id)
      return next
    })
  }, [])

  const confirmAction = useCallback((action: () => void) => {
    if (!blockedRef.current) {
      action()
      return
    }
    pendingActionRef.current = action
    setDialogOpen(true)
  }, [])

  const finishNavigation = useCallback(() => {
    pendingNavigationRef.current = null
    setPendingNavigation(null)
  }, [])

  const beginNavigation = useCallback((href: string) => {
    if (pendingNavigationRef.current) return false

    const normalizedHref =
      typeof window === "undefined"
        ? href
        : (() => {
            const destination = new URL(href, window.location.href)
            return `${destination.pathname}${destination.search}${destination.hash}`
          })()
    const nextPending = { href: normalizedHref, startedAt: Date.now() }
    pendingNavigationRef.current = nextPending
    setPendingNavigation(nextPending)
    return true
  }, [])

  const registerRouteFallback = useCallback(() => {
    activeFallbacksRef.current += 1
    let registered = true

    return () => {
      if (!registered) return
      registered = false
      activeFallbacksRef.current = Math.max(0, activeFallbacksRef.current - 1)
      if (activeFallbacksRef.current === 0 && pendingNavigationRef.current) {
        finishNavigation()
      }
    }
  }, [finishNavigation])

  const allowModernNavigationOnce = useCallback(() => {
    const navigation = (window as Window & { navigation?: NavigationLike }).navigation
    if (!navigation) return
    allowNextNavigationRef.current = true
    window.setTimeout(() => {
      allowNextNavigationRef.current = false
    }, 1000)
  }, [])

  const navigate = useCallback((href: string, options?: { replace?: boolean }) => {
    confirmAction(() => {
      if (typeof window !== "undefined") {
        const destination = new URL(href, window.location.href)
        if (destination.href === window.location.href) return
      }
      if (!beginNavigation(href)) return
      allowModernNavigationOnce()
      if (options?.replace) {
        router.replace(href)
      } else {
        router.push(href)
      }
    })
  }, [allowModernNavigationOnce, beginNavigation, confirmAction, router])

  useEffect(() => {
    if (committedPathnameRef.current === pathname) return
    committedPathnameRef.current = pathname

    const timeout = window.setTimeout(() => {
      if (activeFallbacksRef.current === 0) finishNavigation()
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [finishNavigation, pathname])

  useEffect(() => {
    if (!pendingNavigation) return
    const { startedAt } = pendingNavigation
    const timeout = window.setTimeout(() => {
      if (
        activeFallbacksRef.current === 0 &&
        pendingNavigationRef.current?.startedAt === startedAt
      ) {
        finishNavigation()
      }
    }, NAVIGATION_FAILSAFE_MS)
    return () => window.clearTimeout(timeout)
  }, [finishNavigation, pendingNavigation])

  useEffect(() => {
    if (!hasUnfinishedWork) return

    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = true
    }

    window.addEventListener("beforeunload", beforeUnload)
    return () => window.removeEventListener("beforeunload", beforeUnload)
  }, [hasUnfinishedWork])

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (allowNextNavigationRef.current || event.defaultPrevented || isModifiedClick(event)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a")
      if (!(anchor instanceof HTMLAnchorElement)) return
      const navigation = getAnchorNavigation(anchor)
      if (!navigation || navigation.hashOnly) return

      if (navigation.exactCurrentUrl || pendingNavigationRef.current) {
        stopNavigationEvent(event)
        return
      }

      if (!blockedRef.current) {
        beginNavigation(navigation.href)
        return
      }

      stopNavigationEvent(event)
      confirmAction(() => {
        if (!beginNavigation(navigation.href)) return
        allowModernNavigationOnce()
        router.push(navigation.href)
      })
    }

    document.addEventListener("click", handleClick, true)
    return () => document.removeEventListener("click", handleClick, true)
  }, [allowModernNavigationOnce, beginNavigation, confirmAction, router])

  useEffect(() => {
    const navigation = (window as Window & { navigation?: NavigationLike }).navigation
    if (!navigation) return

    const handleNavigate = (rawEvent: Event) => {
      const event = rawEvent as NavigateEventLike
      if (allowNextNavigationRef.current) {
        allowNextNavigationRef.current = false
        return
      }
      if (!blockedRef.current || event.navigationType === "reload" || event.hashChange || event.downloadRequest) return
      if (event.navigationType !== "traverse" || !event.canIntercept || !event.cancelable) return

      const destination = new URL(event.destination.url)
      if (destination.origin !== window.location.origin) return

      event.preventDefault()
      confirmAction(() => {
        if (!beginNavigation(`${destination.pathname}${destination.search}${destination.hash}`)) return
        allowModernNavigationOnce()
        if (event.destination.key) {
          navigation.traverseTo(event.destination.key)
        } else {
          navigation.navigate(event.destination.url)
        }
      })
    }

    navigation.addEventListener("navigate", handleNavigate)
    return () => navigation.removeEventListener("navigate", handleNavigate)
  }, [allowModernNavigationOnce, beginNavigation, confirmAction])

  useEffect(() => {
    const navigation = (window as Window & { navigation?: NavigationLike }).navigation
    if (navigation) return

    const originalPushState = window.history.pushState.bind(window.history)
    const originalReplaceState = window.history.replaceState.bind(window.history)
    let currentPoint = Number(window.history.state?.[HISTORY_POINT_KEY] ?? 0)
    let restoringDelta: number | null = null
    let restoringHref: string | null = null

    originalReplaceState(historyStateWithPoint(window.history.state, currentPoint), "", currentRelativeUrl())

    window.history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
      currentPoint += 1
      originalPushState(historyStateWithPoint(data, currentPoint), unused, url)
    }
    window.history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => {
      originalReplaceState(historyStateWithPoint(data, currentPoint), unused, url)
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextPoint = Number(event.state?.[HISTORY_POINT_KEY] ?? 0)
      const delta = currentPoint - nextPoint

      if (restoringDelta !== null) {
        const confirmedDelta = restoringDelta
        const confirmedHref = restoringHref
        restoringDelta = null
        restoringHref = null
        currentPoint = nextPoint
        confirmAction(() => {
          if (confirmedHref && !beginNavigation(confirmedHref)) return
          allowNextNavigationRef.current = true
          window.history.go(-confirmedDelta)
        })
        return
      }
      if (allowNextNavigationRef.current) {
        allowNextNavigationRef.current = false
        currentPoint = nextPoint
        return
      }
      if (!blockedRef.current || delta === 0) {
        currentPoint = nextPoint
        if (delta !== 0) beginNavigation(currentRelativeUrl())
        return
      }

      event.stopImmediatePropagation()
      restoringDelta = delta
      restoringHref = currentRelativeUrl()
      window.history.go(delta)
    }

    window.addEventListener("popstate", handlePopState, true)
    return () => {
      window.history.pushState = originalPushState
      window.history.replaceState = originalReplaceState
      window.removeEventListener("popstate", handlePopState, true)
    }
  }, [beginNavigation, confirmAction])

  const contextValue = useMemo<GuardContextValue>(
    () => ({
      register,
      unregister,
      confirmAction,
      navigate,
      navigationPending: pendingNavigation !== null,
      pendingHref: pendingNavigation?.href ?? null,
      registerRouteFallback,
    }),
    [confirmAction, navigate, pendingNavigation, register, registerRouteFallback, unregister],
  )

  return (
    <GuardContext.Provider value={contextValue}>
      {children}
      {pendingNavigation ? (
        <div className="route-navigation-progress" aria-hidden="true">
          <div className="route-navigation-progress-indicator" />
        </div>
      ) : null}
      <ConfirmationDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) pendingActionRef.current = null
        }}
        title="Leave this page?"
        description="You have unfinished changes or an action in progress. If you continue, this work may be lost."
        cancelLabel="Stay"
        confirmLabel="Leave"
        onConfirm={() => {
          const action = pendingActionRef.current
          pendingActionRef.current = null
          setDialogOpen(false)
          action?.()
        }}
      />
    </GuardContext.Provider>
  )
}

export function useUnsavedChangesGuard({ dirty, busy = false }: { dirty: boolean; busy?: boolean }) {
  const context = useContext(GuardContext)
  const id = useId()

  if (!context) {
    throw new Error("useUnsavedChangesGuard must be used within UnsavedChangesProvider.")
  }

  useEffect(() => {
    context.register(id, { dirty, busy })
    return () => context.unregister(id)
  }, [busy, context, dirty, id])

  return {
    confirmAction: context.confirmAction,
    navigate: context.navigate,
  }
}

export function useNavigationFeedback() {
  const context = useContext(GuardContext)

  if (!context) {
    throw new Error("useNavigationFeedback must be used within UnsavedChangesProvider.")
  }

  return {
    navigationPending: context.navigationPending,
    pendingHref: context.pendingHref,
  }
}

export function useRouteLoadingLifecycle() {
  const context = useContext(GuardContext)
  const registerRouteFallback = context?.registerRouteFallback

  useEffect(() => {
    if (!registerRouteFallback) return
    return registerRouteFallback()
  }, [registerRouteFallback])
}
