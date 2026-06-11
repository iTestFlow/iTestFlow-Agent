"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ContentShell } from "@/components/layout/content-shell"
import { ConfigurationForm } from "@/shared/components/live/configuration-form"

export default function SettingsPage() {
  return (
    <ContentShell
      title="Integration Settings"
      description="Manage Azure DevOps, AI provider, and project context sync settings for iTestFlow."
    >
      <div className="space-y-6">
        <Alert className="border-primary/20 bg-primary/10">
          <AlertTitle>Editable live runtime settings</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Values on this page load from the live runtime settings API and save back through it. Re-enter secrets only when rotating credentials.
          </AlertDescription>
        </Alert>
        <ConfigurationForm mode="settings" redirectTo={null} />
      </div>
    </ContentShell>
  )
}
