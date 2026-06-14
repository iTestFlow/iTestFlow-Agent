"use client"

import { Info, Sparkles, SquareTerminal, type LucideIcon } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
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
    <TooltipProvider>
      <div className={cn("inline-flex items-center gap-2", className)}>
        <div
          role="tablist"
          aria-label={ariaLabel}
          className="inline-flex rounded-lg border border-input bg-background p-1"
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="About generation modes"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Info className="size-4" aria-hidden="true" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="block max-w-sm space-y-1.5">
            <p><span className="font-semibold">Auto Generate:</span> Generate directly using the configured LLM provider.</p>
            <p><span className="font-semibold">External LLM:</span> Prepare a structured prompt to copy into an external LLM.</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
