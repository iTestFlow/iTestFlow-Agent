import { ContentShell } from "@/components/layout/content-shell"
import { DashboardsClient } from "@/components/dashboard/dashboard-client"

export default function DashboardsPage() {
  return (
    <ContentShell
      title="Dashboards"
      description="Testing progress, bug status, coverage, and release readiness overview."
    >
      <DashboardsClient />
    </ContentShell>
  )
}
