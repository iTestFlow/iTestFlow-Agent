import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toneClass, type Tone } from "@/components/qa/tone"
import type { FindingSeverity } from "@/types/requirements"
import type { TestSeverity } from "@/types/test-cases"

const severityToneMap: Record<FindingSeverity | TestSeverity, Tone> = {
  Critical: "error",
  High: "error",
  Medium: "warning",
  Low: "success",
}

export function SeverityChip({
  severity,
  className,
}: {
  severity: FindingSeverity | TestSeverity
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full border px-2.5", toneClass[severityToneMap[severity]], className)}
    >
      {severity}
    </Badge>
  )
}
