"use client"

import type { ReactNode } from "react"
import { Loader2, Play } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CopyButton } from "@/components/workflow/copy-button"
import { cn } from "@/lib/utils"

/**
 * External-LLM prompt + response panel shared by every "External LLM" workflow
 * (test design, requirement analysis, bug, effort, knowledge). Renders the
 * read-only prompt with a Copy button, optional prompt-version/schema badges,
 * and the response textarea + submit action. The container owns submission and
 * validation; this component is presentational.
 */
export function ManualLLMPanel({
  title = "External LLM Prompt",
  description = "Review this prompt, run it in your external LLM, then paste the JSON response below to validate it.",
  prompt,
  promptVersion,
  schemaName,
  badges,
  response,
  onResponseChange,
  onSubmit,
  submitting,
  submitLabel = "Validate External Result",
  submittingLabel = "Validating...",
  responseLabel = "External LLM response",
  responsePlaceholder = "Paste the external LLM JSON response here.",
  promptMinHeightClass = "min-h-[360px]",
  responseMinHeightClass = "min-h-[220px]",
  disabled = false,
}: {
  title?: string
  description?: ReactNode
  prompt: string
  promptVersion?: string
  schemaName?: string
  badges?: ReactNode
  response: string
  onResponseChange: (value: string) => void
  onSubmit: () => void
  submitting: boolean
  submitLabel?: string
  submittingLabel?: string
  responseLabel?: string
  responsePlaceholder?: string
  promptMinHeightClass?: string
  responseMinHeightClass?: string
  disabled?: boolean
}) {
  const showBadges = Boolean(promptVersion || schemaName || badges)

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-0.5">
            <CardTitle>{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          <CopyButton text={prompt} label="Copy Prompt" copiedLabel="Copied" />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {showBadges ? (
          <div className="flex flex-wrap items-center gap-2">
            {promptVersion ? <Badge variant="outline">Prompt {promptVersion}</Badge> : null}
            {schemaName ? <Badge variant="outline">{schemaName}</Badge> : null}
            {badges}
          </div>
        ) : null}
        <Textarea
          value={prompt}
          readOnly
          className={cn(
            "bg-muted text-foreground dark:bg-muted font-mono text-xs leading-5",
            promptMinHeightClass,
          )}
          aria-label="External LLM prompt"
        />
        <div className="space-y-2">
          <Label className="text-sm font-medium">{responseLabel}</Label>
          <Textarea
            value={response}
            onChange={(event) => onResponseChange(event.target.value)}
            className={cn("font-mono text-xs", responseMinHeightClass)}
            placeholder={responsePlaceholder}
            aria-label={responseLabel}
          />
        </div>
        <div className="flex justify-end">
          <Button onClick={onSubmit} disabled={disabled || !response.trim() || submitting}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {submitting ? submittingLabel : submitLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
