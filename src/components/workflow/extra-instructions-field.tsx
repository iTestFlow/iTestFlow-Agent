"use client"

import { useId } from "react"

import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Callout } from "@/components/qa/callout"
import { cn } from "@/lib/utils"
import {
  EXTRA_INSTRUCTIONS_HELPER_TEXT,
  EXTRA_INSTRUCTIONS_MAX_LENGTH,
  EXTRA_INSTRUCTIONS_WARNING_TEXT,
} from "@/modules/llm/extra-instructions"

/**
 * Shared "Extra Instructions" textarea with label, helper text, live character
 * counter, over-limit guard, and the responsibility warning. Promoted from the
 * inline copies across the workflow pages. Keeps the canonical
 * EXTRA_INSTRUCTIONS_* constants so the client limit stays in lockstep with the
 * server-side zod validation.
 */
export function ExtraInstructionsField({
  value,
  onChange,
  label = "Extra Instructions",
  helperText = EXTRA_INSTRUCTIONS_HELPER_TEXT,
  placeholder = "Add optional instructions for this run.",
  maxLength = EXTRA_INSTRUCTIONS_MAX_LENGTH,
  className,
}: {
  value: string
  onChange: (value: string) => void
  label?: string
  helperText?: string
  placeholder?: string
  maxLength?: number
  className?: string
}) {
  const id = useId()
  const overLimit = value.length > maxLength
  const showWarning = value.length > 0

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Label htmlFor={id} className="text-sm font-semibold text-foreground">
            {label}
          </Label>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{helperText}</p>
        </div>
        <div className={cn("text-xs font-medium", overLimit ? "text-destructive" : "text-muted-foreground")}>
          {value.length} / {maxLength}
        </div>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
        aria-invalid={overLimit}
        className="min-h-[120px]"
        placeholder={placeholder}
      />
      {overLimit ? (
        <p className="text-xs font-medium text-destructive">
          {label} must be {maxLength} characters or fewer.
        </p>
      ) : null}
      {showWarning ? (
        <Callout tone="warning" className="text-xs">
          {EXTRA_INSTRUCTIONS_WARNING_TEXT}
        </Callout>
      ) : null}
    </div>
  )
}
