import { ContentShell } from "@/components/layout/content-shell"
import { ActivityLogClient } from "@/components/activity-log/activity-log-client"

export default function ActivityLogPage() {
  return (
    <ContentShell
      title="Activity Log"
      description="Review recent system activity, generated outputs, and user actions across iTestFlow."
    >
      <ActivityLogClient />
    </ContentShell>
  )
}
