import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell";
import { TestExecutionEffortClient } from "./test-execution-effort-client";

export const metadata: Metadata = { title: "Test Execution Effort" }

export default function TestExecutionEffortPage() {
  return (
    <ContentShell
      title="Test Execution Effort"
      maxWidth="dashboard"
      description="Estimate the manual QA effort required to execute linked test cases for a selected user story."
    >
      <TestExecutionEffortClient />
    </ContentShell>
  );
}

