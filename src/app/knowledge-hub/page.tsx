import { ContentShell } from "@/components/layout/content-shell"
import { KnowledgeHubClient } from "./knowledge-hub-client"

export default function KnowledgeHubPage() {
  return (
    <ContentShell
      title="Knowledge Hub"
      description="Explore indexed source work items, build compiled knowledge, and monitor project knowledge health."
    >
      <KnowledgeHubClient />
    </ContentShell>
  )
}
