import { PageHeader } from "@/shared/components/ui";
import { ExistingTestCaseReviewClient } from "@/shared/components/live/live-workflows";

export default function ExistingTestCaseReviewPage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Coverage Matrix"
        title="Test Coverage Matrix"
        description="Review linked Azure DevOps test cases against each user story detail, description point, and acceptance criterion."
      />
      <ExistingTestCaseReviewClient />
    </>
  );
}
