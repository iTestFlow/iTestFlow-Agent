import { PageHeader } from "@/shared/components/ui";
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows";

export default function TestCaseDesignSelectPage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Case Design"
        title="Generate Test Cases"
        description="Generate Azure DevOps-ready test cases with automatic project context selection."
      />
      <TestCaseGenerationClient />
    </>
  );
}
