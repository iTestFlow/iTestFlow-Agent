import { ContentShell } from "@/components/layout/content-shell"
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows"

export default function TestCaseDesignContextPage() {
  return (
    <ContentShell
      title="Test Case Design - Context Selection"
      description="Select project-scoped stories and documents before generating test cases for a real Azure DevOps work item."
    >
      <TestCaseGenerationClient />
    </ContentShell>
  )
}
