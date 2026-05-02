import { PageHeader } from "@/shared/components/ui";
import { PublishTestCasesClient } from "@/shared/components/live/live-workflows";

export default function PublishPage() {
  return (
    <>
      <PageHeader
        eyebrow="Publish Test Cases"
        title="Publish Test Cases to Azure Test Plan Suite"
        description="Only selected and valid test cases are published, added to the selected suite, and linked to the target user story."
      />
      <PublishTestCasesClient />
    </>
  );
}
