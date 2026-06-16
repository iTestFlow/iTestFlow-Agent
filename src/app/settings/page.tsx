"use client"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ContentShell } from "@/components/layout/content-shell"
import { ConfigurationForm } from "@/shared/components/live/configuration-form"

export default function SettingsPage() {
  return (
    <ContentShell
      title="Settings"
      description="Manage integrations, AI generation, knowledge retrieval, automation, and value metrics for iTestFlow."
    >
      <div className="space-y-4">
        <Alert className="border-primary/20 bg-primary/10 py-3">
          <AlertTitle className="text-sm">Live runtime settings</AlertTitle>
          <AlertDescription className="text-muted-foreground">
            Saved locally through the runtime settings API. Re-enter secrets only when rotating credentials.
          </AlertDescription>
        </Alert>
        <ConfigurationForm mode="settings" redirectTo={null} />
      </div>
    </ContentShell>
  )
}
