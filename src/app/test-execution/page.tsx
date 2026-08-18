import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell"
import { TestExecutionClient } from "./test-execution-client"

export const metadata: Metadata = { title: "Test Execution" }

export default function TestExecutionPage() {
  return (
    <ContentShell
      title="Test Execution"
      description="Import, write, and edit test cases, run them through the AI-driven browser agent, then review evidence and publish outcomes to Azure DevOps."
    >
      <TestExecutionClient />
    </ContentShell>
  )
}
