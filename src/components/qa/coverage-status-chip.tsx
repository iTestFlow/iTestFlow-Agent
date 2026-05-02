import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { CoverageStatus } from "@/types/coverage"

const coverageClasses: Record<CoverageStatus | "Partial" | "Gap", string> = {
  Covered: "border-[#22A06B]/30 bg-[#E9F8F1] text-[#216E4E]",
  "Partially covered": "border-[#F5CD47]/60 bg-[#FFF7D6] text-[#7F5F01]",
  "Not covered": "border-[#E34935]/30 bg-[#FFECEB] text-[#AE2E24]",
  "Not applicable": "border-[#DCDFE4] bg-white text-[#626F86]",
  "Needs review": "border-[#6554C0]/30 bg-[#F3F0FF] text-[#6554C0]",
  Partial: "border-[#F5CD47]/60 bg-[#FFF7D6] text-[#7F5F01]",
  Gap: "border-[#E34935]/30 bg-[#FFECEB] text-[#AE2E24]",
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
      className={cn("rounded-full border px-2.5", coverageClasses[status], className)}
    >
      {status}
    </Badge>
  )
}

