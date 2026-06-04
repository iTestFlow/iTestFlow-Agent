import { AlertCircle, RefreshCw } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function ErrorState({
  title,
  message,
  technicalDetails,
  onRetry,
}: {
  title: string
  message: string
  technicalDetails?: string
  onRetry?: () => void
}) {
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
          {technicalDetails ? (
            <details className="w-full">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                Technical details
              </summary>
              <div className="mt-3 rounded-lg border border-border bg-card p-3 font-mono text-xs text-muted-foreground">
                {technicalDetails}
              </div>
            </details>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}
