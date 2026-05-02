import { PageHeader } from "@/shared/components/ui";
import { AzureDevOpsWorkItemsClient } from "@/shared/components/live/live-workflows";

export default function AzureDevOpsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Azure DevOps"
        title="Work Items"
        description="Manual sync fetches work items from the selected Azure DevOps project only and indexes them into project-scoped RAG."
      />
      <AzureDevOpsWorkItemsClient />
    </>
  );
}
