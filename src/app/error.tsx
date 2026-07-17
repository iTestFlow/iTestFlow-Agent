"use client"

import { useEffect } from "react"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Callout } from "@/components/qa/callout"

// Next.js auto-wraps this around {children} in layout.tsx, so it only catches
// errors from a page's own content -- the topbar/sidebar chrome in AppShell keeps
// rendering, and the user can still navigate away instead of facing a blank crash.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Unhandled route error", error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4 lg:p-6">
      <div className="w-full max-w-md">
        <Callout
          tone="error"
          role="alert"
          title="Something went wrong"
          action={
            <Button variant="outline" size="sm" onClick={reset}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Try again
            </Button>
          }
        >
          <p>{error.message || "An unexpected error occurred."}</p>
          {error.digest ? (
            <p className="mt-1 text-xs text-muted-foreground">Reference: {error.digest}</p>
          ) : null}
          <p className="mt-1 text-xs text-muted-foreground">Try again, or reload the page if it keeps happening.</p>
        </Callout>
      </div>
    </div>
  )
}
