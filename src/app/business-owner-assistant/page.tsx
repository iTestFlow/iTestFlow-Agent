import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell";
import { getOptionalSession } from "@/modules/auth/session.service";

export const metadata: Metadata = { title: "Business Owner Assistant" }
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";
import { resolveActiveWorkspaceForUser } from "@/modules/workspace/workspace.service";
import { BusinessOwnerAssistantClient } from "./business-owner-assistant-client";

async function getWorkspaceRole(): Promise<WorkspaceRole | null> {
  const session = await getOptionalSession();
  if (!session) return null;
  const workspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId);
  return workspace?.role ?? null;
}

export default async function BusinessOwnerAssistantPage() {
  const workspaceRole = await getWorkspaceRole();

  return (
    <ContentShell
      title="Business Owner Assistant"
      maxWidth="dashboard"
      description="Ask questions grounded in the selected project's indexed context and saved knowledge hub."
    >
      <BusinessOwnerAssistantClient workspaceRole={workspaceRole} />
    </ContentShell>
  );
}
