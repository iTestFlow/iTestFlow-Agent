import type { Metadata } from "next";

import { ContentShell } from "@/components/layout/content-shell";

import { TestExecutionClient } from "./test-execution-client";

export const metadata: Metadata = { title: "Test Execution" };

export default function TestExecutionPage() {
  return (
    <ContentShell
      title="Test Execution"
      description="Execute natural-language tests across your application's UI, API, and database with automatic guardrails, durable evidence, and defect candidates."
    >
      <TestExecutionClient />
    </ContentShell>
  );
}
