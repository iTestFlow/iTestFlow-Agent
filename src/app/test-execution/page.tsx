import type { Metadata } from "next";

import { ContentShell } from "@/components/layout/content-shell";
import { getOptionalSession } from "@/modules/auth/session.service";
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import { resolveActiveWorkspaceForUser } from "@/modules/workspace/workspace.service";

import { TestExecutionClient } from "./test-execution-client";

export const metadata: Metadata = { title: "Test Execution" };

async function getWorkspaceRole(): Promise<WorkspaceRole | null> {
  const session = await getOptionalSession();
  if (!session) return null;
  const workspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId);
  return workspace?.role ?? null;
}

export default async function TestExecutionPage() {
  const workspaceRole = await getWorkspaceRole();
  return (
    <ContentShell
      title="Test Execution"
      description="Execute natural-language tests across your application's UI, API, and database with controlled capabilities, durable evidence, and defect candidates."
    >
      <TestExecutionClient workspaceRole={workspaceRole} />
    </ContentShell>
  );
}
