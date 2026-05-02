import { ContentShell } from "@/components/layout/content-shell"
import { PublishTestCasesClient } from "@/shared/components/live/live-workflows"

export default function PublishTestCasesPage() {
  return (
    <ContentShell
      title="Publish Test Cases to Azure Test Plan Suite"
      description="Select a Test Plan and Test Suite before publishing approved test cases."
    >
      <PublishTestCasesClient />
    </ContentShell>
  )
}
