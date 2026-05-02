import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function LoadingState({ rows = 5 }: { rows?: number }) {
  return (
    <Card className="qa-card">
      <CardContent className="space-y-3 p-4">
        <Skeleton className="h-6 w-48" />
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </CardContent>
    </Card>
  )
}

