import { ContentShell } from "@/components/layout/content-shell"
import { ProjectContextClient } from "./context-client"

export default function ContextPage() {
  return (
    <ContentShell
      title="Project Context / RAG"
      description="Manage project-scoped documents, synced work items, indexed chunks, and semantic search."
    >
      <ProjectContextClient />
    </ContentShell>
  )
}
