import { ContentShell } from "@/components/layout/content-shell";
import { BulkTaskClient } from "./bulk-task-client";

export default function BulkTasksPage() {
  return (
    <ContentShell
      title="Bulk Task Creation"
      description="Create one Azure DevOps Task under each selected User Story."
    >
      <BulkTaskClient />
    </ContentShell>
  );
}
