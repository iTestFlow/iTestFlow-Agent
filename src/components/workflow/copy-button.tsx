"use client"

import { Check, Copy } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useCopyFeedback } from "@/components/qa/use-copy-feedback"
import { cn } from "@/lib/utils"

/**
 * Copy-to-clipboard button with built-in transient feedback. Replaces the
 * per-page "Copy Prompt" / "Copy JSON" implementations.
 */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  variant = "outline",
  size = "sm",
  className,
}: {
  text: string
  label?: string
  copiedLabel?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
}) {
  const { copied, copy } = useCopyFeedback()

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      onClick={() => void copy(text)}
      aria-label={copied ? copiedLabel : label}
    >
      {copied ? <Check className={cn("size-4")} aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      {copied ? copiedLabel : label}
    </Button>
  )
}
