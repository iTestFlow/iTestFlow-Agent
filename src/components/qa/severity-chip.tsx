import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { FindingSeverity } from "@/types/requirements"
import type { TestSeverity } from "@/types/test-cases"

const severityClasses: Record<FindingSeverity | TestSeverity, string> = {
  Critical: "border-[#E34935]/30 bg-[#FFECEB] text-[#AE2E24]",
  High: "border-[#F15B50]/30 bg-[#FFF0EF] text-[#AE2E24]",
  Medium: "border-[#F5CD47]/60 bg-[#FFF7D6] text-[#7F5F01]",
  Low: "border-[#22A06B]/30 bg-[#E9F8F1] text-[#216E4E]",
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
      className={cn("rounded-full border px-2.5", severityClasses[severity], className)}
    >
      {severity}
    </Badge>
  )
}

