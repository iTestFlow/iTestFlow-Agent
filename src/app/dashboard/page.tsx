import { ContentShell } from "@/components/layout/content-shell"
import { LiveDashboard } from "@/shared/components/live/live-workflows"

export default function DashboardPage() {
  return (
    <ContentShell
      title="Dashboard"
      description="A project-scoped QA command center for requirement analysis, context management, test design, coverage, and publishing."
    >
      <LiveDashboard />
    </ContentShell>
  )
}
