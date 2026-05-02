import { ContentShell } from "@/components/layout/content-shell"
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows"

export default function RequirementAnalyzePage() {
  return (
    <ContentShell
      title="Requirement Analysis - Context Selection"
      description="Select RAG-suggested project context before running requirement analysis for a real Azure DevOps work item."
    >
      <RequirementAnalysisClient />
    </ContentShell>
  )
}
