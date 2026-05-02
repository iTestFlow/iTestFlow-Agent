import { ContentShell } from "@/components/layout/content-shell"
import { ExistingTestCaseReviewClient } from "@/shared/components/live/live-workflows"

export default function ExistingReviewPage() {
  return (
    <ContentShell
      title="Existing Linked Test Case Review"
      description="Review Azure DevOps test cases already linked to the selected user story. No paste, upload, or import workflow is provided."
    >
      <ExistingTestCaseReviewClient />
    </ContentShell>
  )
}
