import type { ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toneClass, toneSolidClass, type Tone } from "@/components/qa/tone"
import type { FindingSeverity } from "@/types/requirements"
import type { TestSeverity } from "@/types/test-cases"

const severityToneMap: Record<FindingSeverity | TestSeverity, Tone> = {
  Critical: "error",
  High: "error",
  Medium: "warning",
  Low: "success",
}

/**
 * Shared presentational severity/status pill. `solid` uses the filled treatment —
 * reserved for the single most important item in a set (e.g. `Critical`) so it
 * stands apart from the tinted `toneClass` items — and the label text is always
 * rendered, so meaning never depends on color alone. Both `SeverityChip` (typed
 * `FindingSeverity | TestSeverity` union) and the workflow `SeverityBadge`
 * (untrusted `string` input) delegate here so the tone ramp + solid rule live once.
 */
export function SeverityPill({
  tone,
  solid = false,
  className,
  children,
}: {
  tone: Tone
  solid?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full border", solid ? toneSolidClass[tone] : toneClass[tone], className)}
    >
      {children}
    </Badge>
  )
}

export function SeverityChip({
  severity,
  className,
}: {
  severity: FindingSeverity | TestSeverity
  className?: string
}) {
  return (
    <SeverityPill
      tone={severityToneMap[severity]}
      solid={severity === "Critical"}
      className={cn("px-2.5", className)}
    >
      {severity}
    </SeverityPill>
  )
}
