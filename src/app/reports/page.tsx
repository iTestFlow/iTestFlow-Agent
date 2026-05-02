import { Download } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContentShell } from "@/components/layout/content-shell"

export default function ReportsPage() {
  return (
    <ContentShell
      title="Reports / Export"
      description="Export requirement analysis, selected test cases, coverage, publish summaries, and full local run data."
    >
      <Alert className="border-[#0C66E4]/20 bg-[#E9F2FF]">
        <AlertTitle>Exports require live run data</AlertTitle>
        <AlertDescription className="text-[#44546F]">
          Report/export pages no longer show prefilled run identifiers or generated payloads. Use the workflow APIs and export completed live runs when available.
        </AlertDescription>
      </Alert>
      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Export Endpoints</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-[#44546F]">
          <p>`/api/export/[kind]` now returns only live export placeholders until a real run exists.</p>
          <Button variant="outline">
            <Download className="size-4" />
            Export requires completed live workflow data
          </Button>
        </CardContent>
      </Card>
    </ContentShell>
  )
}
