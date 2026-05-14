import { ContentShell } from "@/components/layout/content-shell"
import { DashboardClient } from "@/components/dashboard/dashboard-client"

export default function DashboardPage() {
  return (
    <ContentShell
      title="Dashboard"
      description="A project-scoped DevOps analytics command center for requirement analysis, context management, test design, coverage, and publishing."
    >
      <DashboardClient />
    </ContentShell>
  )
}
