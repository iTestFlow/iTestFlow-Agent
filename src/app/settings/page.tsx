import type { Metadata } from "next"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ContentShell } from "@/components/layout/content-shell"
import { SettingsTabs } from "@/shared/components/settings/settings-tabs"

export const metadata: Metadata = { title: "Settings" }

export default function SettingsPage() {
  return (
    <ContentShell
      title="Settings"
      description="Manage your private Azure DevOps and LLM credentials, and workspace-wide configuration."
    >
      <div className="space-y-4">
        <Alert className="border-primary/20 bg-primary/10 py-3">
          <AlertTitle className="text-sm">Your credentials are private</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Your Azure DevOps PAT and LLM API key are encrypted and used only for your own actions.
            Workspace settings (members, retrieval, sync schedule) are shared and managed by owners and admins.
          </AlertDescription>
        </Alert>
        <SettingsTabs />
      </div>
    </ContentShell>
  )
}
