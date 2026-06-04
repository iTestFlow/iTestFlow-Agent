import { CheckCircle2, CircleDashed, Loader2, TriangleAlert } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { toneClass, type Tone } from "@/components/qa/tone"

type StatusTone = "success" | "warning" | "error" | "info" | "neutral" | "draft"

const statusToneMap: Record<StatusTone, Tone> = {
  success: "success",
  warning: "warning",
  error: "error",
  info: "info",
  neutral: "neutral",
  draft: "draft",
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
      className={cn("gap-1.5 rounded-full border px-2.5", toneClass[statusToneMap[tone]], className)}
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
