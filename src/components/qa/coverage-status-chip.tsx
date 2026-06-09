import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toneClass, type Tone } from "@/components/qa/tone"
import type { CoverageStatus } from "@/types/coverage"

const coverageToneMap: Record<CoverageStatus | "Partial" | "Gap", Tone> = {
  Covered: "success",
  "Partially covered": "warning",
  "Not covered": "error",
  "Not applicable": "neutral",
  "Needs review": "draft",
  Partial: "warning",
  Gap: "error",
}

export function CoverageStatusChip({
  status,
  className,
}: {
  status: CoverageStatus | "Partial" | "Gap"
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full border px-2.5", toneClass[coverageToneMap[status]], className)}
    >
      {status}
    </Badge>
  )
}
