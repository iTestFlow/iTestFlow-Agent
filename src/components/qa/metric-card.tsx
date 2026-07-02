import type { LucideIcon } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { toneClass, type Tone } from "@/components/qa/tone"

const metricToneMap = {
  blue: "primary",
  green: "success",
  yellow: "warning",
  red: "error",
  purple: "draft",
  neutral: "neutral",
} satisfies Record<string, Tone>

export function MetricCard({
  title,
  value,
  description,
  icon: Icon,
  tone = "blue",
}: {
  title: string
  value: string
  description: string
  icon: LucideIcon
  tone?: keyof typeof metricToneMap
}) {
  return (
    <Card className="qa-card">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{title}</p>
            <div className="mt-2 break-words text-2xl font-bold leading-tight text-foreground tabular-nums">{value}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
          <div className={cn("rounded-lg border p-2", toneClass[metricToneMap[tone]])}>
            <Icon className="size-4" aria-hidden="true" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}


