import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export type StatTone = "neutral" | "primary" | "success" | "warning" | "error"

/**
 * Compact metric tile: a label, a prominent value, and optional detail/footnote.
 * Consolidates the duplicated "tile" boxes (estimate tiles, summary tiles, dense
 * statistics grids). For icon + description KPI cards use MetricCard; for a
 * 0–100 score with a progress bar use ScoreCard.
 *
 * size="md"  → headline tile (uppercase label, 2xl value, p-4)
 * size="sm"  → dense stat tile (plain label, base value, p-3)
 */
const surfaceClass: Record<StatTone, string> = {
  neutral: "border bg-muted/25",
  primary: "border-primary/20 bg-primary/10 ring-1 ring-primary/20",
  success: "border-success/30 bg-success/10",
  warning: "border-warning/40 bg-warning/15",
  error: "border-destructive/30 bg-destructive/10",
}

const valueClass: Record<StatTone, string> = {
  neutral: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning-foreground dark:text-warning",
  error: "text-destructive",
}

export function StatCard({
  label,
  value,
  detail,
  tone = "neutral",
  size = "md",
  className,
}: {
  label: ReactNode
  value: ReactNode
  detail?: ReactNode
  tone?: StatTone
  size?: "sm" | "md"
  className?: string
}) {
  return (
    <div className={cn("rounded-lg border", size === "sm" ? "p-3" : "p-4", surfaceClass[tone], className)}>
      <div
        className={cn(
          "text-xs text-muted-foreground",
          size === "md" && "font-medium uppercase tracking-normal",
        )}
      >
        {label}
      </div>
      <div className={cn("font-semibold tabular-nums", size === "sm" ? "mt-1 text-base" : "mt-2 text-2xl", valueClass[tone])}>
        {value}
      </div>
      {detail ? <div className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
    </div>
  )
}
