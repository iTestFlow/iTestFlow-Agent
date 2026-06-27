"use client"

import { useCallback, type ReactNode } from "react"
import { ClipboardPaste, Loader2, Play } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CopyButton } from "@/components/workflow/copy-button"
import { WorkflowContextCitations } from "@/components/workflow/workflow-context-citations"
import { cn } from "@/lib/utils"
import type { WorkflowContextCitation } from "@/modules/rag/workflow-context-citations"

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
  contextCitations,
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
  contextCitations?: WorkflowContextCitation[]
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
        <div className="space-y-0.5">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
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
        {contextCitations !== undefined ? (
          <WorkflowContextCitations citations={contextCitations} />
        ) : null}
        <ManualLLMFields
          prompt={prompt}
          response={response}
          onResponseChange={onResponseChange}
          onSubmit={onSubmit}
          submitting={submitting}
          submitLabel={submitLabel}
          submittingLabel={submittingLabel}
          responseLabel={responseLabel}
          responsePlaceholder={responsePlaceholder}
          promptMinHeightClass={promptMinHeightClass}
          responseMinHeightClass={responseMinHeightClass}
          disabled={disabled}
        />
      </CardContent>
    </Card>
  )
}

export function ManualLLMFields({
  prompt,
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
  prompt: string
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
  const pasteResponse = useCallback(async () => {
    try {
      const clipboardText = await navigator.clipboard.readText()
      onResponseChange(clipboardText)
    } catch (error) {
      console.error("Clipboard paste failed", error)
    }
  }, [onResponseChange])

  return (
    <>
      <div className="relative">
        <CopyButton
          text={prompt}
          label="Copy Prompt"
          copiedLabel="Copied"
          className="absolute right-3 top-3 z-10 bg-background/95 shadow-sm backdrop-blur-sm"
        />
        <Textarea
          value={prompt}
          readOnly
          className={cn(
            "bg-muted pt-12 text-foreground dark:bg-muted font-mono text-xs leading-5",
            promptMinHeightClass,
          )}
          aria-label="External LLM prompt"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-sm font-medium">{responseLabel}</Label>
        <div className="relative">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="absolute right-3 top-3 z-10 bg-background/95 shadow-sm backdrop-blur-sm"
            onClick={() => void pasteResponse()}
            disabled={disabled}
          >
            <ClipboardPaste className="size-4" />
            Paste Response
          </Button>
          <Textarea
            value={response}
            onChange={(event) => onResponseChange(event.target.value)}
            className={cn("pt-12 font-mono text-xs", responseMinHeightClass)}
            placeholder={responsePlaceholder}
            aria-label={responseLabel}
          />
        </div>
      </div>
      <div className="flex justify-end">
        <Button onClick={onSubmit} disabled={disabled || !response.trim() || submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {submitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </>
  )
}
