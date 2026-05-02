import { Upload } from "lucide-react";
import { Badge, Button, Card, CardHeader, PageHeader, TextInput } from "@/shared/components/ui";

export default function ContextPage() {
  return (
    <>
      <PageHeader
        eyebrow="Project Context / RAG"
        title="Project Context"
        description="Documents, work items, chunks, and embeddings are stored locally and isolated by the active Azure DevOps project."
        action={
          <Button>
            <Upload className="h-4 w-4" />
            Upload Documents
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[220px_1fr_260px]">
        <Card>
          <CardHeader title="Sources" />
          <div className="space-y-1 p-3">
            {["Documents", "Azure Work Items", "Indexed Chunks", "Search", "Settings"].map((item) => (
              <button key={item} className="focus-ring flex w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted">
                {item}
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <div className="flex gap-3 border-b p-4">
            <TextInput placeholder="Search documents, work items, chunks..." />
            <Button variant="secondary">Search</Button>
          </div>
          <div className="p-6 text-sm text-muted-foreground">
            No indexed context is displayed until a live Azure DevOps sync or document ingestion run writes project-scoped chunks.
          </div>
        </Card>

        <Card>
          <CardHeader title="Indexing Status" />
          <div className="space-y-4 p-4">
            <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-full border-8 border-emerald-500 text-xl font-semibold text-slate-950">
              Live
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>Documents</span><span>Runtime</span></div>
              <div className="flex justify-between"><span>Total Chunks</span><span>From DB</span></div>
              <div className="flex justify-between"><span>Last Indexed</span><span>Audit log</span></div>
            </div>
            <Button className="w-full">Re-index All</Button>
            <Badge tone="emerald" className="w-full justify-center">All content scoped to selected project</Badge>
          </div>
        </Card>
      </div>
    </>
  );
}
