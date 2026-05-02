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
    <Alert className="border-[#E34935]/30 bg-[#FFECEB] text-[#172B4D]">
      <AlertCircle className="size-4 text-[#E34935]" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-3 text-[#44546F]">
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
              <summary className="cursor-pointer text-xs font-medium text-[#44546F]">
                Technical details
              </summary>
              <div className="mt-3 rounded-lg border border-[#DCDFE4] bg-white p-3 font-mono text-xs text-[#44546F]">
                {technicalDetails}
              </div>
            </details>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  )
}
