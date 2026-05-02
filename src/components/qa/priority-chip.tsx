import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { TestPriority } from "@/types/test-cases"

const priorityClasses: Record<TestPriority, string> = {
  P0: "border-[#E34935]/30 bg-[#FFECEB] text-[#AE2E24]",
  P1: "border-[#F5CD47]/60 bg-[#FFF7D6] text-[#7F5F01]",
  P2: "border-[#0C66E4]/30 bg-[#E9F2FF] text-[#0052CC]",
  P3: "border-[#DCDFE4] bg-white text-[#44546F]",
}

export function PriorityChip({
  priority,
  className,
}: {
  priority: TestPriority
  className?: string
}) {
  return (
    <Badge
      variant="outline"
      className={cn("rounded-full border px-2.5", priorityClasses[priority], className)}
    >
      {priority}
    </Badge>
  )
}

