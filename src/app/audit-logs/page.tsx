import { Button, PageHeader } from "@/shared/components/ui";
import { AuditLogsClient } from "@/shared/components/live/live-workflows";

export default function AuditLogsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Audit Logs / History"
        title="Audit Logs"
        description="Review syncs, AI runs, context selections, edits, publish confirmations, Azure IDs, and failures."
        action={<Button variant="secondary">Export JSON</Button>}
      />
      <AuditLogsClient />
    </>
  );
}
