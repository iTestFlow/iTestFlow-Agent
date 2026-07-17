"use client"

import { useEffect } from "react"

import "./globals.css"

// Last-resort boundary: only fires when the root layout itself throws (e.g. a
// provider crashing), which error.tsx cannot catch since it lives inside that
// layout. Replaces the entire document, so this renders its own <html>/<body> and
// avoids depending on anything from the app shell that could itself be the crash.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("Unhandled root layout error", error)
  }, [error])

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground antialiased">
        <div className="w-full max-w-md space-y-4 rounded-lg border border-destructive/30 bg-destructive/10 p-6 text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="text-sm text-foreground/90">{error.message || "An unexpected error occurred."}</p>
          {error.digest ? <p className="text-xs text-foreground/60">Reference: {error.digest}</p> : null}
          <p className="text-xs text-foreground/60">Try reloading the page if it keeps happening.</p>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
