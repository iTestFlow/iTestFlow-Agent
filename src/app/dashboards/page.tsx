import { ContentShell } from "@/components/layout/content-shell"
import { DashboardsClient } from "@/components/dashboard/dashboard-client"

export default function DashboardsPage() {
  return (
    <ContentShell
      title="Dashboards"
      description="A project-scoped DevOps analytics command center for requirements analysis, context management, test design, coverage, and publishing."
    >
      <DashboardsClient />
    </ContentShell>
  )
}
