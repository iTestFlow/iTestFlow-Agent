import { ContentShell } from "@/components/layout/content-shell"
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows"

export default function RequirementResultsPage() {
  return (
    <ContentShell
      title="Requirement Analysis - Findings Results"
      description="Review, select, and edit findings before building the final Azure DevOps comment."
    >
      <RequirementAnalysisClient />
    </ContentShell>
  )
}
