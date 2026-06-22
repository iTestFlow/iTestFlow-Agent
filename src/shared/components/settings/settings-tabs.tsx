"use client"

import { useState } from "react"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConnectionsSection } from "./connections-section"
import { AiGenerationSection } from "./ai-generation-section"
import { KnowledgeContextSection } from "./knowledge-context-section"
import { AutomationSection } from "./automation-section"
import { MembersSection } from "./members-section"

type SettingsTab = "connections" | "ai" | "context" | "automation" | "members"

const TABS: { value: SettingsTab; label: string }[] = [
  { value: "connections", label: "Connections" },
  { value: "ai", label: "AI & Generation" },
  { value: "context", label: "Knowledge & Context" },
  { value: "automation", label: "Automation" },
  { value: "members", label: "Members" },
]

export function SettingsTabs() {
  const [tab, setTab] = useState<SettingsTab>("connections")

  return (
    <Tabs value={tab} onValueChange={(value) => setTab(value as SettingsTab)} className="w-full min-w-0 flex-col gap-4">
      <div className="max-w-full overflow-x-auto pb-1">
        <TabsList variant="primary" className="h-auto min-w-max justify-start">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="h-9 flex-none px-3">
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <TabsContent value="connections" className="space-y-4">
        <ConnectionsSection />
      </TabsContent>
      <TabsContent value="ai" className="space-y-4">
        <AiGenerationSection />
      </TabsContent>
      <TabsContent value="context" className="space-y-4">
        <KnowledgeContextSection />
      </TabsContent>
      <TabsContent value="automation" className="space-y-4">
        <AutomationSection />
      </TabsContent>
      <TabsContent value="members" className="space-y-4">
        <MembersSection />
      </TabsContent>
    </Tabs>
  )
}
