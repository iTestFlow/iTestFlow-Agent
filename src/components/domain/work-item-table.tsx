"use client"

import { useMemo, useState } from "react"
import { Eye } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { EmptyState } from "@/components/qa/empty-state"
import { PriorityChip } from "@/components/qa/priority-chip"
import { StatusChip } from "@/components/qa/status-chip"
import { WorkItemDetailsDrawer } from "@/components/domain/work-item-details-drawer"
import { cn } from "@/lib/utils"
import { formatDateTime } from "@/shared/lib/utils"
import type { WorkItem } from "@/types/azure-devops"

export function WorkItemTable({ items }: { items: WorkItem[] }) {
  const [selectedIds, setSelectedIds] = useState<string[]>([items[0]?.id ?? ""])
  const [active, setActive] = useState<WorkItem | null>(null)

  const allSelected = items.length > 0 && selectedIds.length === items.length
  const selectedCount = selectedIds.filter(Boolean).length

  const filteredItems = useMemo(() => items, [items])

  if (items.length === 0) {
    return (
      <EmptyState
        title="No work items synced"
        description="Sync Azure DevOps work items for the selected project before analysis."
        actionLabel="Sync now"
      />
    )
  }

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 text-sm text-muted-foreground">
          <span>{selectedCount} selected</span>
          <Button size="sm" variant="outline">
            Open selected
          </Button>
        </div>
          <Table containerClassName="max-h-[70vh] overflow-y-auto overscroll-contain">
            <TableHeader className="sticky top-0 z-20 bg-card">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => setSelectedIds(checked ? items.map((item) => item.id) : [])}
                    aria-label="Select all work items"
                  />
                </TableHead>
                <TableHead>ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="min-w-[280px]">Title</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Assigned To</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Iteration</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => {
                const selected = selectedIds.includes(item.id)
                return (
                  <TableRow key={item.id} className={cn("qa-table-row", selected && "qa-table-row-selected")}>
                    <TableCell>
                      <Checkbox
                        checked={selected}
                        onCheckedChange={(checked) =>
                          setSelectedIds((current) =>
                            checked ? [...current, item.id] : current.filter((id) => id !== item.id)
                          )
                        }
                        aria-label={`Select ${item.id}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs font-semibold text-primary">{item.id}</TableCell>
                    <TableCell><Badge variant="secondary">{item.type}</Badge></TableCell>
                    <TableCell className="font-medium text-foreground">{item.title}</TableCell>
                    <TableCell><StatusChip tone={item.state === "Closed" ? "success" : item.state === "Resolved" ? "info" : "neutral"}>{item.state}</StatusChip></TableCell>
                    <TableCell>{item.assignedTo}</TableCell>
                    <TableCell>
                      <PriorityChip priority={item.priority.startsWith("1") ? "P0" : item.priority.startsWith("2") ? "P1" : item.priority.startsWith("3") ? "P2" : "P3"} />
                    </TableCell>
                    <TableCell>{item.iteration}</TableCell>
                    <TableCell>{formatDateTime(item.updatedAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {item.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="icon-sm" variant="ghost" onClick={() => setActive(item)} aria-label={`Preview ${item.id}`}>
                        <Eye className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
      </div>
      <WorkItemDetailsDrawer workItem={active} open={Boolean(active)} onOpenChange={(open) => !open && setActive(null)} />
    </>
  )
}

