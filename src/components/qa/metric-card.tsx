import type { LucideIcon } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const toneClasses = {
  blue: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  green: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  yellow: "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  red: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300",
  purple: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  neutral: "border-border bg-secondary text-secondary-foreground",
}

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
  tone?: keyof typeof toneClasses
}) {
  return (
    <Card className="qa-card">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{title}</p>
            <div className="mt-2 truncate text-2xl font-bold text-foreground">{value}</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          </div>
          <div className={cn("rounded-lg border p-2", toneClasses[tone])}>
            <Icon className="size-4" aria-hidden="true" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

