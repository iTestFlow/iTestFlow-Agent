import type { Metadata } from "next";

import { ContentShell } from "@/components/layout/content-shell";

import { RunDetailClient } from "./run-detail-client";

export const metadata: Metadata = { title: "Test Execution Report" };

/**
 * Native, durable execution report — the app's first dynamic page route.
 * Everything renders from the database, so the report survives refreshes and
 * worker restarts; while the run is live the client keeps polling.
 */
export default async function TestExecutionRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return (
    <ContentShell
      title="Test Execution Report"
      description="Durable, evidence-backed record of a test execution run."
    >
      <RunDetailClient runId={runId} />
    </ContentShell>
  );
}
