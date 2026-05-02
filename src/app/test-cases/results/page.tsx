import { PageHeader } from "@/shared/components/ui";
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows";

export default function TestCaseResultsPage() {
  return (
    <>
      <PageHeader
        eyebrow="Test Case Design"
        title="Results List with Inline Editable Titles and Steps"
        description="Review, edit, select, duplicate, delete, and recalculate coverage before publishing."
      />
      <TestCaseGenerationClient />
    </>
  );
}
