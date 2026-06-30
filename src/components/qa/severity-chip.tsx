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

export function SeverityChip({
  severity,
  className,
}: {
  severity: FindingSeverity | TestSeverity
  className?: string
}) {
  // `Critical` uses the solid red treatment so it stands apart from the tinted
  // red `High`; the label text is always shown, so meaning is never color-only.
  const solid = severity === "Critical"
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full border px-2.5", solid ? toneSolidClass.error : toneClass[severityToneMap[severity]], className)}
    >
      {severity}
    </Badge>
  )
}
