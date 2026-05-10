import { ContentShell } from "@/components/layout/content-shell"
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows"

export default function RequirementAnalyzePage() {
  return (
    <ContentShell
      title="Requirement Analysis"
      description="Run requirement analysis for a real Azure DevOps work item with automatic project context selection."
    >
      <RequirementAnalysisClient />
    </ContentShell>
  )
}
