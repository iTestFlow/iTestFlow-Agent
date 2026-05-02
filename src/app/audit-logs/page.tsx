import { ContentShell } from "@/components/layout/content-shell"
import { AuditLogsClient } from "@/shared/components/live/live-workflows"

export default function AuditLogsPage() {
  return (
    <ContentShell
      title="Audit Logs / History"
      description="Inspect local workflow history, payload summaries, failures, and related run IDs."
    >
      <AuditLogsClient />
    </ContentShell>
  )
}
