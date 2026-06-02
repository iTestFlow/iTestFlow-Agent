import { ContentShell } from "@/components/layout/content-shell"
import { ProjectContextClient } from "./context-client"

export default function ContextPage() {
  return (
    <ContentShell
      title="Project Context"
      description="Explore indexed source work items, build compiled knowledge, and monitor project knowledge health."
    >
      <ProjectContextClient />
    </ContentShell>
  )
}
