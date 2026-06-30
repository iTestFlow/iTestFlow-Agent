import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell"
import { RequirementsAnalysisClient } from "./requirements-analysis-client"

export const metadata: Metadata = { title: "Requirements Analysis" }

export default function RequirementsAnalysisPage() {
  return (
    <ContentShell
      title="Requirements Analysis"
      maxWidth="dashboard"
      description="Run requirements analysis for a real Azure DevOps work item with automatic project context selection."
    >
      <RequirementsAnalysisClient />
    </ContentShell>
  )
}
