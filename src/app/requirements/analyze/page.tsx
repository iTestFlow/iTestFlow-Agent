import { ContentShell } from "@/components/layout/content-shell"
import { RequirementAnalysisClient } from "./requirement-analysis-client"

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
