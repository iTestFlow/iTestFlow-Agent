import type { Metadata } from "next"
import { ContentShell } from "@/components/layout/content-shell"
import { getOptionalSession } from "@/modules/auth/session.service"

export const metadata: Metadata = { title: "Knowledge Hub" }
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service"
import { resolveActiveWorkspaceForUser } from "@/modules/workspace/workspace.service"
import { KnowledgeHubClient } from "./knowledge-hub-client"

async function getWorkspaceRole(): Promise<WorkspaceRole | null> {
  const session = await getOptionalSession()
  if (!session) return null
  const workspace = await resolveActiveWorkspaceForUser(session.userId, session.activeWorkspaceId)
  return workspace?.role ?? null
}

export default async function KnowledgeHubPage() {
  const workspaceRole = await getWorkspaceRole()
  const canBuildKnowledge = workspaceRole === "owner" || workspaceRole === "admin"

  return (
    <ContentShell
      title="Knowledge Hub"
      maxWidth="dashboard"
      description={
        canBuildKnowledge
          ? "Explore indexed source work items, build compiled knowledge, and monitor project knowledge health."
          : "Explore indexed source work items and monitor project knowledge health."
      }
    >
      <KnowledgeHubClient workspaceRole={workspaceRole} />
    </ContentShell>
  )
}
