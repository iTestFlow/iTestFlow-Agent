import { PageHeader } from "@/shared/components/ui";
import { PublishTestCasesClient } from "@/shared/components/live/live-workflows";

export default function PublishSummaryPage() {
  return (
    <>
      <PageHeader
        eyebrow="Publish Test Cases"
        title="Publish Result Summary"
        description="Local audit record has been stored with Azure DevOps IDs, link status, target plan, and target suite."
      />
      <PublishTestCasesClient />
    </>
  );
}
