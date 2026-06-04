"use client"

import { ExternalLink, Link2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SeverityChip } from "@/components/qa/severity-chip"
import type { WorkItem } from "@/types/azure-devops"

export function WorkItemDetailsDrawer({
  workItem,
  open,
  onOpenChange,
}: {
  workItem: WorkItem | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border p-5">
          <div className="flex items-center gap-2">
            {workItem ? <Badge variant="outline">{workItem.id}</Badge> : null}
            {workItem ? <Badge variant="secondary">{workItem.type}</Badge> : null}
          </div>
          <SheetTitle className="text-xl font-semibold text-foreground">
            {workItem?.title ?? "Work item details"}
          </SheetTitle>
          <SheetDescription>
            Azure DevOps details are scoped to the currently selected project.
          </SheetDescription>
        </SheetHeader>

        {workItem ? (
          <ScrollArea className="h-[calc(100vh-120px)]">
            <div className="space-y-5 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <Info label="State" value={workItem.state} />
                <Info label="Assigned to" value={workItem.assignedTo} />
                <Info label="Area" value={workItem.area} />
                <Info label="Iteration" value={workItem.iteration} />
              </div>

              <Tabs defaultValue="description">
                <TabsList>
                  <TabsTrigger value="description">Description</TabsTrigger>
                  <TabsTrigger value="criteria">Acceptance Criteria</TabsTrigger>
                  <TabsTrigger value="links">Links & Tests</TabsTrigger>
                </TabsList>
                <TabsContent value="description" className="mt-4 rounded-lg border border-border bg-card p-4">
                  <p className="text-sm leading-6 text-muted-foreground">{workItem.description}</p>
                </TabsContent>
                <TabsContent value="criteria" className="mt-4 rounded-lg border border-border bg-card p-4">
                  <ol className="space-y-3 text-sm text-muted-foreground">
                    {workItem.acceptanceCriteria.map((criterion, index) => (
                      <li key={criterion} className="flex gap-3">
                        <span className="font-mono text-xs text-muted-foreground">AC{index + 1}</span>
                        <span>{criterion}</span>
                      </li>
                    ))}
                  </ol>
                </TabsContent>
                <TabsContent value="links" className="mt-4 space-y-4 rounded-lg border border-border bg-card p-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Info label="TestedBy relations" value={`${workItem.testedByCount}`} />
                    <Info label="Tests relations" value={`${workItem.testsCount}`} />
                  </div>
                  <div className="space-y-2">
                    {workItem.links.map((link) => (
                      <div key={`${link.id}-${link.relation}`} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                        <div>
                          <div className="text-sm font-medium text-foreground">{link.id} - {link.title}</div>
                          <div className="text-xs text-muted-foreground">{link.relation}</div>
                        </div>
                        <Link2 className="size-4 text-muted-foreground" aria-hidden="true" />
                      </div>
                    ))}
                  </div>
                </TabsContent>
              </Tabs>

              <div className="flex flex-wrap items-center gap-2">
                <SeverityChip severity={workItem.priority.startsWith("1") ? "Critical" : workItem.priority.startsWith("2") ? "High" : "Medium"} />
                {workItem.tags.map((tag) => (
                  <Badge key={tag} variant="outline">{tag}</Badge>
                ))}
              </div>

              <Button>
                <ExternalLink className="size-4" />
                View in Azure DevOps
              </Button>
            </div>
          </ScrollArea>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted p-3">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-semibold text-foreground">{value}</div>
    </div>
  )
}

