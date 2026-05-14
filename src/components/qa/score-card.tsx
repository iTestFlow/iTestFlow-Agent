import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { scoreLabel } from "@/shared/lib/utils"

export function ScoreCard({
  title,
  score,
  description,
}: {
  title: string
  score: number
  description: string
}) {
  return (
    <Card className="qa-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold text-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-end justify-between">
          <span className="text-3xl font-bold text-foreground">{score}</span>
          <span className="text-xs font-medium text-muted-foreground">{scoreLabel(score)}</span>
        </div>
        <Progress value={score} aria-label={`${title} score ${score}`} />
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </CardContent>
    </Card>
  )
}

