import { ContentShell } from "@/components/layout/content-shell"
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows"

export default function TestCaseDesignResultsPage() {
  return (
    <ContentShell
      title="Test Case Design - Results with Inline Editing"
      description="Review, select, edit, add, duplicate, and prepare generated test cases before publication."
    >
      <TestCaseGenerationClient />
    </ContentShell>
  )
}
