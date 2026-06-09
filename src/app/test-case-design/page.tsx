import { ContentShell } from "@/components/layout/content-shell"
import { TestCaseDesignClient } from "./test-case-design-client"

export default function TestCaseDesignPage() {
  return (
    <ContentShell
      title="Test Case Design"
      description="Generate test cases for a real Azure DevOps work item with automatic project context selection."
    >
      <TestCaseDesignClient />
    </ContentShell>
  )
}
