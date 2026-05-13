import { ContentShell } from "@/components/layout/content-shell";
import { ExistingTestCaseReviewClient } from "@/shared/components/live/live-workflows";

export default function TestCoverageMatrixPage() {
  return (
    <ContentShell
      title="Test Coverage Matrix"
      description="Review linked Azure DevOps test cases against each user story detail, description point, and acceptance criterion."
    >
      <ExistingTestCaseReviewClient />
    </ContentShell>
  );
}
