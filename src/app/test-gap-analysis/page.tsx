import { ContentShell } from "@/components/layout/content-shell";
import { TestGapAnalysisClient } from "./test-gap-analysis-client";

export default function TestGapAnalysisPage() {
  return (
    <ContentShell
      title="Test Gap Analysis"
      description="Review linked Azure DevOps test cases against each user story detail, description point, and acceptance criterion."
    >
      <TestGapAnalysisClient />
    </ContentShell>
  );
}
