import { PageHeader } from "@/shared/components/ui";
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows";

export default function FullEditTestCasePage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Case Design"
        title="Full Edit Test Case"
        description="Advanced edit surface for metadata, preconditions, test data, steps, expected results, and traceability."
      />
      <TestCaseGenerationClient />
    </>
  );
}
