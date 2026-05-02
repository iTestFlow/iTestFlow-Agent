import { ContentShell } from "@/components/layout/content-shell"
import { RequirementAnalysisClient } from "@/shared/components/live/live-workflows"

export default function RequirementCommentPreviewPage() {
  return (
    <ContentShell
      title="Requirement Analysis - Final Comment Preview"
      description="Only selected and approved findings are included in this Azure DevOps comment preview."
    >
      <RequirementAnalysisClient />
    </ContentShell>
  )
}
