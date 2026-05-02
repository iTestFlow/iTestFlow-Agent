import { ContentShell } from "@/components/layout/content-shell"
import { PublishTestCasesClient } from "@/shared/components/live/live-workflows"

export default function PublishResultPage() {
  return (
    <ContentShell
      title="Publish Result Summary"
      description="Review successes, failures, Azure DevOps test case IDs, and link status after publishing."
    >
      <PublishTestCasesClient />
    </ContentShell>
  )
}
