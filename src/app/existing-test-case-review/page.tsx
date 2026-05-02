import { PageHeader } from "@/shared/components/ui";
import { ExistingTestCaseReviewClient } from "@/shared/components/live/live-workflows";

export default function ExistingTestCaseReviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Existing Linked Test Case Review"
        title="Fetch and Review Azure DevOps Linked Test Cases"
        description="Only TestedBy / Tests linked cases for the selected user story are reviewed. No paste or import is used."
      />
      <ExistingTestCaseReviewClient />
    </>
  );
}
