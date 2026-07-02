"use client"

import { Loader2 } from "lucide-react"

import { useRouteLoadingLifecycle } from "@/components/navigation/unsaved-changes-provider"

export function RouteLoadingLifecycle() {
  useRouteLoadingLifecycle()
  return null
}

export function RouteLoadingState() {
  useRouteLoadingLifecycle()

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-16">
      <div
        role="status"
        aria-live="polite"
        aria-label="Loading page"
        className="content-surface flex max-w-sm items-center gap-3 px-5 py-4"
      >
        <Loader2
          className="size-5 shrink-0 animate-spin text-primary motion-reduce:animate-none"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">Loading page…</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Preparing the next view.</p>
        </div>
      </div>
    </div>
  )
}
