import type { LucideIcon } from "lucide-react"
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { toneClass, toneTextClass } from "@/components/qa/tone"

export type CalloutTone = "info" | "success" | "warning" | "error"

const defaultIcon: Record<CalloutTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: AlertCircle,
}

/**
 * Tonal inline message box (info/success/warning/error). Replaces the
 * hand-rolled ErrorBlock/EmptyBlock and the scattered amber/red callout divs.
 * Border + tint come from the shared tone map; title/body stay in the
 * foreground color for readability in both light and dark mode.
 */
export function Callout({
  tone = "info",
  title,
  children,
  icon,
  action,
  className,
}: {
  tone?: CalloutTone
  title?: ReactNode
  children?: ReactNode
  icon?: LucideIcon
  action?: ReactNode
  className?: string
}) {
  const Icon = icon ?? defaultIcon[tone]

  return (
    <div className={cn("flex gap-3 rounded-lg border p-3", toneClass[tone], className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", toneTextClass[tone])} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <div className="text-sm font-semibold text-foreground">{title}</div> : null}
        {children ? <div className="text-sm leading-6 text-foreground/90">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
