import { CheckCircle2, CircleDashed, Loader2, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type StatusTone = "success" | "warning" | "error" | "info" | "neutral" | "draft"

const toneClasses: Record<StatusTone, string> = {
  success: "border-[#22A06B]/30 bg-[#E9F8F1] text-[#216E4E]",
  warning: "border-[#F5CD47]/60 bg-[#FFF7D6] text-[#7F5F01]",
  error: "border-[#E34935]/30 bg-[#FFECEB] text-[#AE2E24]",
  info: "border-[#0C66E4]/30 bg-[#E9F2FF] text-[#0052CC]",
  neutral: "border-[#DCDFE4] bg-white text-[#44546F]",
  draft: "border-[#6554C0]/30 bg-[#F3F0FF] text-[#6554C0]",
}

const icons = {
  success: CheckCircle2,
  warning: TriangleAlert,
  error: TriangleAlert,
  info: CircleDashed,
  neutral: CircleDashed,
  draft: CircleDashed,
}

export function StatusChip({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode
  tone?: StatusTone
  className?: string
}) {
  const Icon = icons[tone]

  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 rounded-full border px-2.5", toneClasses[tone], className)}
    >
      {tone === "info" && children === "Syncing" ? (
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="size-3" aria-hidden="true" />
      )}
      {children}
    </Badge>
  )
}

