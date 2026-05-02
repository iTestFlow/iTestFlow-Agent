import { PageHeader } from "@/shared/components/ui";
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows";

export default function TestCaseDesignSelectPage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Case Design"
        title="Select Requirement and Context Stories"
        description="Choose generation options after approving the final selected context set."
      />
      <TestCaseGenerationClient />
    </>
  );
}
