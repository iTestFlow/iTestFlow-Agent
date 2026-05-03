import { FileSearch } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContentShell } from "@/components/layout/content-shell"
import { EmptyState } from "@/components/qa/empty-state"

export default function ContextPage() {
  return (
    <ContentShell
      title="Project Context / RAG"
      description="Manage project-scoped documents, synced work items, indexed chunks, and semantic search."
    >
      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Project Context Status</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            title="No context data loaded yet"
            description="Use your real ingestion/indexing flow to populate documents, indexed chunks, and search results for the selected project."
            actionLabel="Open Azure DevOps Sync"
          />
        </CardContent>
      </Card>
      <Button variant="outline">
        <FileSearch className="size-4" />
        Context search requires live index data
      </Button>
    </ContentShell>
  )
}
