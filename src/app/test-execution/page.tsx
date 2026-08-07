import type { Metadata } from "next";

import { ContentShell } from "@/components/layout/content-shell";

import { TestExecutionClient } from "./test-execution-client";

export const metadata: Metadata = { title: "Test Execution" };

export default function TestExecutionPage() {
  return (
    <ContentShell
      title="Test Execution"
      description="Execute test cases against your application through a controlled browser — from a user story's linked test cases or manually typed steps — with evidence, a durable report, and defect candidates."
    >
      <TestExecutionClient />
    </ContentShell>
  );
}
