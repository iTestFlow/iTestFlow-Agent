import { ContentShell } from "@/components/layout/content-shell";
import { TestExecutionEffortClient } from "./test-execution-effort-client";

export default function TestExecutionEffortPage() {
  return (
    <ContentShell
      title="Test Execution Effort"
      description="Estimate the manual QA effort required to execute linked test cases for a selected user story."
    >
      <TestExecutionEffortClient />
    </ContentShell>
  );
}

