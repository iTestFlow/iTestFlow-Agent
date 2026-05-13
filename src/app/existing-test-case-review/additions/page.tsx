import { PageHeader } from "@/shared/components/ui";
import { ExistingTestCaseReviewClient } from "@/shared/components/live/live-workflows";

export default function SuggestedAdditionsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Coverage Matrix"
        title="Suggested Additions"
        description="Review suggested additions, then create and link them to the selected Azure DevOps user story."
      />
      <ExistingTestCaseReviewClient />
    </>
  );
}
