import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell"
import { TestCaseDesignClient } from "./test-case-design-client"

export const metadata: Metadata = { title: "Test Case Design" }

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
