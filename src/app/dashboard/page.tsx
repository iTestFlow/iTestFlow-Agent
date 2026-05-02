import { BarChart3 } from "lucide-react";
import { Button, Card, CardHeader, PageHeader } from "@/shared/components/ui";
import { LiveDashboard } from "@/shared/components/live/live-workflows";

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        eyebrow="Home / Dashboard"
        title="Dashboard"
        description="Project-scoped QA intelligence overview for requirement analysis, test design, RAG context, and publish readiness."
      />

      <LiveDashboard />

      <Card className="mt-6">
        <CardHeader title="Live Workflow Status" description="Run a sync or AI workflow to populate audit logs and exportable results." />
        <div className="p-4 text-sm text-muted-foreground">
          This build no longer loads demo runs. It reads Azure DevOps and LLM results from your configured providers.
        </div>
      </Card>

      <Card className="mt-6">
        <CardHeader title="Quick Actions" />
        <div className="grid gap-3 p-4 md:grid-cols-3 xl:grid-cols-6">
          {["Sync Azure DevOps", "Analyze Requirement", "Design Test Cases", "Review Linked Test Cases", "View Coverage Matrix", "View Reports"].map((action) => (
            <Button key={action} variant="secondary" className="justify-start">
              <BarChart3 className="h-4 w-4" />
              {action}
            </Button>
          ))}
        </div>
        <div className="border-t p-4">
          <div className="text-sm text-muted-foreground">Actions are disabled by API validation until an Azure DevOps project is selected.</div>
        </div>
      </Card>
    </>
  );
}
