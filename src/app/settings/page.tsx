"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ContentShell } from "@/components/layout/content-shell"
import { MyCredentialsCard } from "@/shared/components/credentials/my-credentials-card"
import { WorkspaceMembersCard } from "@/shared/components/workspace/workspace-members-card"

export default function SettingsPage() {
  return (
    <ContentShell
      title="Settings"
      description="Manage your private Azure DevOps and LLM credentials for iTestFlow."
    >
      <div className="space-y-4">
        <Alert className="border-primary/20 bg-primary/10 py-3">
          <AlertTitle className="text-sm">Your credentials are private</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Your Azure DevOps PAT and LLM API key are encrypted and used only for your own actions.
            Workspace data (dashboards, history, Knowledge Hub) is shared with your workspace.
          </AlertDescription>
        </Alert>
        <MyCredentialsCard />
        <WorkspaceMembersCard />
      </div>
    </ContentShell>
  )
}
