import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toneClass, type Tone } from "@/components/qa/tone"
import type { TestPriority } from "@/types/test-cases"

const priorityToneMap: Record<TestPriority, Tone> = {
  P0: "error",
  P1: "warning",
  P2: "info",
  P3: "neutral",
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
      className={cn("rounded-full border px-2.5", toneClass[priorityToneMap[priority]], className)}
    >
      {priority}
    </Badge>
  )
}
