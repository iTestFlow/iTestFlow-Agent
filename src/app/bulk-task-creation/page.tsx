import { ContentShell } from "@/components/layout/content-shell";
import { BulkTaskCreationClient } from "./bulk-task-creation-client";

export default function BulkTaskCreationPage() {
  return (
    <ContentShell
      title="Bulk Task Creation"
      description="Define task templates, select target stories, then review and create the Azure DevOps task batch."
    >
      <BulkTaskCreationClient />
    </ContentShell>
  );
}
