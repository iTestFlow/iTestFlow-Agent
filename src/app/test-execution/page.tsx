import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell"
import { PlaywrightExecutionClient } from "./playwright-execution-client"

export const metadata: Metadata = { title: "Automated Test Execution" }

export default function TestExecutionPage() {
  return <ContentShell title="Automated Test Execution" description="Run Azure Test Plan steps through a bounded Playwright MCP agent, review the stored results, then explicitly publish outcomes to Azure DevOps."><PlaywrightExecutionClient /></ContentShell>
}
