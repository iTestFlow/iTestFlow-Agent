"use client"

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"

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
}

const GuardContext = createContext<GuardContextValue | null>(null)
const HISTORY_POINT_KEY = "__itestflowNavigationPoint"

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

function shouldGuardAnchor(anchor: HTMLAnchorElement) {
  if (anchor.target && anchor.target.toLowerCase() !== "_self") return false
  if (anchor.hasAttribute("download")) return false
  if (!anchor.href) return false

  const destination = new URL(anchor.href, window.location.href)
  if (destination.origin !== window.location.origin) return false

  const current = new URL(window.location.href)
  if (
    destination.pathname === current.pathname &&
    destination.search === current.search &&
    destination.hash !== current.hash
  ) {
    return false
  }

  return destination.href !== current.href
}

export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const [registrations, setRegistrations] = useState<Map<string, GuardState>>(() => new Map())
  const [dialogOpen, setDialogOpen] = useState(false)
  const pendingActionRef = useRef<(() => void) | null>(null)
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
      allowModernNavigationOnce()
      if (options?.replace) {
        router.replace(href)
      } else {
        router.push(href)
      }
    })
  }, [allowModernNavigationOnce, confirmAction, router])

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
      if (!blockedRef.current || allowNextNavigationRef.current || event.defaultPrevented || isModifiedClick(event)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a")
      if (!(anchor instanceof HTMLAnchorElement) || !shouldGuardAnchor(anchor)) return

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()

      const destination = new URL(anchor.href, window.location.href)
      confirmAction(() => {
        allowModernNavigationOnce()
        router.push(`${destination.pathname}${destination.search}${destination.hash}`)
      })
    }

    document.addEventListener("click", handleClick, true)
    return () => document.removeEventListener("click", handleClick, true)
  }, [allowModernNavigationOnce, confirmAction, router])

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
  }, [allowModernNavigationOnce, confirmAction])

  useEffect(() => {
    const navigation = (window as Window & { navigation?: NavigationLike }).navigation
    if (navigation) return

    const originalPushState = window.history.pushState.bind(window.history)
    const originalReplaceState = window.history.replaceState.bind(window.history)
    let currentPoint = Number(window.history.state?.[HISTORY_POINT_KEY] ?? 0)
    let restoringDelta: number | null = null

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
        restoringDelta = null
        currentPoint = nextPoint
        confirmAction(() => {
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
        return
      }

      event.stopImmediatePropagation()
      restoringDelta = delta
      window.history.go(delta)
    }

    window.addEventListener("popstate", handlePopState, true)
    return () => {
      window.history.pushState = originalPushState
      window.history.replaceState = originalReplaceState
      window.removeEventListener("popstate", handlePopState, true)
    }
  }, [confirmAction])

  const contextValue = useMemo<GuardContextValue>(
    () => ({ register, unregister, confirmAction, navigate }),
    [confirmAction, navigate, register, unregister],
  )

  return (
    <GuardContext.Provider value={contextValue}>
      {children}
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
