import { ContentShell } from "@/components/layout/content-shell";
import { BulkTaskCreationClient } from "./bulk-task-creation-client";

export default function BulkTaskCreationPage() {
  return (
    <ContentShell
      title="Bulk Task Creation"
      description="Create one Azure DevOps Task under each selected User Story."
    >
      <BulkTaskCreationClient />
    </ContentShell>
  );
}
