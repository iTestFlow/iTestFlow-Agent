import { Save } from "lucide-react";
import { Badge, Button, Card, CardHeader, PageHeader, SelectInput, TextInput } from "@/shared/components/ui";

export default function SettingsPage() {
  const tabs = ["LLM Provider", "Azure DevOps", "Active Project", "Data & Storage", "Prompts", "Scoring", "Audit & Logs", "System"];

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Settings"
        description="Configure local storage, providers, prompt versions, and project isolation defaults."
        action={
          <Button>
            <Save className="h-4 w-4" />
            Save Changes
          </Button>
        }
      />
      <Card>
        <div className="flex flex-wrap gap-2 border-b p-3">
          {tabs.map((tab, index) => (
            <button key={tab} className={`focus-ring rounded-md px-3 py-2 text-sm ${index === 0 ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
              {tab}
            </button>
          ))}
        </div>
        <div className="grid gap-6 p-5 xl:grid-cols-[1fr_360px]">
          <div className="space-y-5">
            <Card className="shadow-none">
              <CardHeader title="Select Active Azure DevOps Project" description="All actions require an active selected project." />
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <div>
                  <label className="mb-2 block text-sm font-medium">Organization</label>
                  <TextInput placeholder="Configured by AZURE_DEVOPS_ORG_URL" readOnly />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium">Project</label>
                  <TextInput placeholder="Use the header selector after credentials are configured" readOnly />
                </div>
              </div>
            </Card>
            <Card className="shadow-none">
              <CardHeader title="LLM Provider" description="Provider-based architecture with structured JSON validation." />
              <div className="grid gap-4 p-4 md:grid-cols-3">
                <SelectInput><option>OpenAI</option><option>Gemini</option><option>Anthropic</option><option>Ollama</option></SelectInput>
                <TextInput placeholder="Configured by provider model env var" readOnly />
                <TextInput type="password" placeholder="Stored in .env.local only" readOnly />
              </div>
            </Card>
          </div>
          <Card className="shadow-none">
            <CardHeader title="Project Info" />
            <div className="space-y-3 p-4 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Project ID</span><span className="font-mono text-xs">Selected in header</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Work Items</span><span>Live sync</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Last Sync</span><span>Audit log</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Last Indexing</span><span>Audit log</span></div>
              <Badge tone="emerald" className="w-full justify-center">All data scoped to this project</Badge>
            </div>
          </Card>
        </div>
      </Card>
    </>
  );
}
