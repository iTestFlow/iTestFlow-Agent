import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { StatusChip } from "@/components/qa/status-chip"
import type { PublishResult } from "@/types/test-cases"

export function PublishResultSummary({
  results,
  projectName = "Selected Azure DevOps project",
  targetStoryLabel = "Selected user story",
  testPlanName = "Selected Test Plan",
  testSuiteName = "Selected Test Suite",
}: {
  results: PublishResult[]
  projectName?: string
  targetStoryLabel?: string
  testPlanName?: string
  testSuiteName?: string
}) {
  const successes = results.filter((result) => result.status === "Published").length
  const failed = results.length - successes

  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="qa-card">
          <CardHeader><CardTitle className="text-base">Success count</CardTitle></CardHeader>
          <CardContent className="text-3xl font-bold text-success">{successes}</CardContent>
        </Card>
        <Card className="qa-card">
          <CardHeader><CardTitle className="text-base">Failed count</CardTitle></CardHeader>
          <CardContent className="text-3xl font-bold text-destructive">{failed}</CardContent>
        </Card>
        <Card className="qa-card">
          <CardHeader><CardTitle className="text-base">Publish progress</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <Progress value={(successes / Math.max(results.length, 1)) * 100} />
            <p className="text-xs text-muted-foreground">{successes} of {results.length} completed</p>
          </CardContent>
        </Card>
      </div>

      <Alert className={failed ? "border-warning/40 bg-warning/15" : "border-success/30 bg-success/10"}>
        <AlertTitle>{failed ? "Publish completed with failures" : "Publish completed successfully"}</AlertTitle>
        <AlertDescription className="text-muted-foreground">
          Project: {projectName}. Target story: {targetStoryLabel}. Test Plan: {testPlanName}. Test Suite: {testSuiteName}.
        </AlertDescription>
      </Alert>

      <Card className="qa-card overflow-hidden">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Azure DevOps ID</TableHead>
                <TableHead>Link status</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map((result) => (
                <TableRow key={result.id} className="qa-table-row">
                  <TableCell className="font-medium text-foreground">{result.title}</TableCell>
                  <TableCell><StatusChip tone={result.status === "Published" ? "success" : "error"}>{result.status}</StatusChip></TableCell>
                  <TableCell>{result.azureDevOpsId ? <Badge variant="outline">{result.azureDevOpsId}</Badge> : "-"}</TableCell>
                  <TableCell><StatusChip tone={result.linkStatus === "Linked" ? "success" : result.linkStatus === "Pending" ? "warning" : "error"}>{result.linkStatus}</StatusChip></TableCell>
                  <TableCell className="text-muted-foreground">{result.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline">Retry failed items</Button>
        <Button>View in Azure DevOps</Button>
      </div>
    </div>
  )
}
