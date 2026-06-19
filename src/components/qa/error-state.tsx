"use client"

import { AlertCircle, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/workflow/copy-button"
import type { ErrorTechnicalContext } from "@/modules/shared/errors/app-error"

export function ErrorState({
  title,
  message,
  technicalDetails,
  technicalContext,
  onRetry,
}: {
  title: string
  message: string
  technicalDetails?: string
  technicalContext?: ErrorTechnicalContext
  onRetry?: () => void
}) {
  const detailsText = technicalDetails?.trim()
  const showTextDetails = Boolean(detailsText && detailsText !== message.trim())
  const hasContext = Boolean(technicalContext && Object.keys(technicalContext).length > 0)
  const showDetails = showTextDetails || hasContext
  const copyText = buildCopyDetails(technicalContext, showTextDetails ? detailsText : undefined)

  return (
    <Alert className="border-destructive/30 bg-destructive/10 text-foreground">
      <AlertCircle className="size-4 text-destructive" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3 text-muted-foreground">
        <p>{message}</p>
        <div className="flex flex-wrap gap-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Retry
            </Button>
          ) : null}
          {showDetails ? (
            <details className="w-full">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Technical details
              </summary>
              <div className="mt-3 space-y-3 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
                <div className="flex justify-end">
                  <CopyButton text={copyText} label="Copy details" copiedLabel="Copied" size="sm" />
                </div>
                {technicalContext ? <TechnicalContextRows context={technicalContext} /> : null}
                <TechnicalBlock label="JSON snippet" value={technicalContext?.jsonSnippet} />
                <TechnicalBlock label="Raw output excerpt" value={technicalContext?.rawOutputExcerpt} />
                {showTextDetails ? (
                  <div className="whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono">
                    {detailsText}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}

function TechnicalContextRows({ context }: { context: ErrorTechnicalContext }) {
  const rows = [
    { label: "Provider", value: context.provider },
    { label: "Model", value: context.model },
    { label: "Schema", value: context.schemaName },
    { label: "Finish reason", value: context.finishReason },
    { label: "Tokens", value: context.tokenUsage ? formatTokenUsage(context.tokenUsage) : undefined },
    { label: "Parse position", value: context.parsePosition?.toString() },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value))

  if (!rows.length) return null

  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.label} className="min-w-0 rounded-md border border-border bg-muted/30 px-3 py-2">
          <dt className="text-[11px] font-medium uppercase text-muted-foreground">{row.label}</dt>
          <dd className="mt-1 break-words font-mono text-foreground">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function TechnicalBlock({ label, value }: { label: string; value?: string }) {
  if (!value) return null
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-muted/40 p-3 font-mono">
        {value}
      </div>
    </div>
  )
}

function buildCopyDetails(context: ErrorTechnicalContext | undefined, detailsText: string | undefined) {
  const lines: string[] = []
  if (context?.provider) lines.push(`Provider: ${context.provider}`)
  if (context?.model) lines.push(`Model: ${context.model}`)
  if (context?.schemaName) lines.push(`Schema: ${context.schemaName}`)
  if (context?.finishReason) lines.push(`Finish reason: ${context.finishReason}`)
  if (context?.tokenUsage) lines.push(`Tokens: ${formatTokenUsage(context.tokenUsage)}`)
  if (context?.parsePosition !== undefined) lines.push(`Parse position: ${context.parsePosition}`)
  if (context?.jsonSnippet) lines.push(`JSON snippet:\n${context.jsonSnippet}`)
  if (context?.rawOutputExcerpt) lines.push(`Raw output excerpt:\n${context.rawOutputExcerpt}`)
  if (detailsText) lines.push(`Details:\n${detailsText}`)
  return lines.join("\n\n")
}

function formatTokenUsage(tokenUsage: NonNullable<ErrorTechnicalContext["tokenUsage"]>) {
  return [
    tokenUsage.input !== undefined ? `input=${tokenUsage.input}` : undefined,
    tokenUsage.output !== undefined ? `output=${tokenUsage.output}` : undefined,
    tokenUsage.total !== undefined ? `total=${tokenUsage.total}` : undefined,
  ].filter(Boolean).join(", ")
}
