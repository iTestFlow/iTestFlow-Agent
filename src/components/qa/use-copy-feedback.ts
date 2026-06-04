"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Clipboard copy with transient "copied" feedback. Centralizes the
 * copy-then-reset-after-N-ms pattern that was duplicated inline across the
 * external-LLM panels and "Copy JSON" buttons.
 */
export function useCopyFeedback(resetMs = 2000) {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        return
      }
      setCopied(true)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setCopied(false), resetMs)
    },
    [resetMs],
  )

  return { copied, copy }
}
