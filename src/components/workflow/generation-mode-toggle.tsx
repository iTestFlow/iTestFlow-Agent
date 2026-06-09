"use client"

import { Sparkles, SquareTerminal, type LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export type GenerationMode = "auto" | "manual"

/**
 * Segmented Auto Generate / External LLM toggle shared by every AI workflow.
 * Replaces the four near-identical inline toggles. Token-based so it adapts to
 * light and dark mode.
 */
export function GenerationModeToggle({
  mode,
  onChange,
  autoLabel = "Auto Generate",
  manualLabel = "External LLM",
  autoIcon: AutoIcon = Sparkles,
  manualIcon: ManualIcon = SquareTerminal,
  ariaLabel = "LLM execution mode",
  className,
}: {
  mode: GenerationMode
  onChange: (mode: GenerationMode) => void
  autoLabel?: string
  manualLabel?: string
  autoIcon?: LucideIcon
  manualIcon?: LucideIcon
  ariaLabel?: string
  className?: string
}) {
  const itemClass = (value: GenerationMode) =>
    cn(
      "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition",
      mode === value
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground",
    )

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex rounded-lg border border-input bg-background p-1", className)}
    >
      <button
        type="button"
        role="tab"
        aria-selected={mode === "auto"}
        className={itemClass("auto")}
        onClick={() => onChange("auto")}
      >
        <AutoIcon className="size-4 shrink-0" aria-hidden="true" />
        {autoLabel}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === "manual"}
        className={itemClass("manual")}
        onClick={() => onChange("manual")}
      >
        <ManualIcon className="size-4 shrink-0" aria-hidden="true" />
        {manualLabel}
      </button>
    </div>
  )
}
