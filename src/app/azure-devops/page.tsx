import { ContentShell } from "@/components/layout/content-shell"
import { AzureDevOpsWorkItemsClient } from "@/shared/components/live/live-workflows"

export default function AzureDevOpsPage() {
  return (
    <ContentShell
      title="Azure DevOps Work Items"
      description="Sync, filter, inspect, and select project-scoped work items before analysis."
    >
      <AzureDevOpsWorkItemsClient />
    </ContentShell>
  )
}
