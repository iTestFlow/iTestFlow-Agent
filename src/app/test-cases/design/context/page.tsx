import { ContentShell } from "@/components/layout/content-shell"
import { TestCaseGenerationClient } from "@/shared/components/live/live-workflows"

export default function TestCaseDesignContextPage() {
  return (
    <ContentShell
      title="Test Case Design"
      description="Generate test cases for a real Azure DevOps work item with automatic project context selection."
    >
      <TestCaseGenerationClient />
    </ContentShell>
  )
}
