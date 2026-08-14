import type { Metadata } from "next"
import { Callout } from "@/components/qa/callout"
import { ContentShell } from "@/components/layout/content-shell"
import { SettingsTabs } from "@/shared/components/settings/settings-tabs"

export const metadata: Metadata = { title: "Settings" }

export default function SettingsPage() {
  return (
    <ContentShell
      title="Settings"
      description="Manage your private work-management and LLM credentials, and workspace-wide configuration."
    >
      <div className="space-y-4">
        <Callout tone="info" title="Your credentials are private">
          Your provider credentials and LLM API key are encrypted and used only for your own actions.
          Workspace settings (members, retrieval, sync schedule) are shared and managed by owners and admins.
        </Callout>
        <SettingsTabs />
      </div>
    </ContentShell>
  )
}
