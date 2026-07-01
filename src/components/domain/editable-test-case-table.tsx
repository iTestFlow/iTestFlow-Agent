"use client"

import { useState } from "react"
import { Copy, Edit, Plus, RefreshCw, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { InlineEditableSteps } from "@/components/qa/inline-editable-steps"
import { InlineEditableText } from "@/components/qa/inline-editable-text"
import { PriorityChip } from "@/components/qa/priority-chip"
import { SeverityChip } from "@/components/qa/severity-chip"
import { TestCaseEditDrawer } from "@/components/domain/test-case-edit-drawer"
import { cn } from "@/lib/utils"
import type { GeneratedTestCase } from "@/types/test-cases"

export function EditableTestCaseTable({ testCases }: { testCases: GeneratedTestCase[] }) {
  const [rows, setRows] = useState(testCases)
  const [active, setActive] = useState<GeneratedTestCase | null>(null)
  const selectedCount = rows.filter((row) => row.selected).length
  const allSelected = rows.length > 0 && selectedCount === rows.length

  function patchRow(id: string, patch: Partial<GeneratedTestCase>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function duplicate(row: GeneratedTestCase) {
    setRows((current) => [
      ...current,
      {
        ...row,
        id: `${row.id}-COPY`,
        title: `${row.title} (copy)`,
        selected: true,
      },
    ])
  }

  function addNew() {
    setRows((current) => [
      ...current,
      {
        ...current[0],
        id: `TC-NEW-${current.length + 1}`,
        title: "New manual test case",
        selected: true,
      },
    ])
  }

  return (
    <>
      <Card className="qa-card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="text-sm text-muted-foreground">{selectedCount} selected test cases</div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline"><RefreshCw className="size-3.5" />Regenerate All</Button>
            <Button size="sm" variant="outline" onClick={addNew}><Plus className="size-3.5" />Add New Test Case</Button>
            <Button size="sm" variant="outline">Export Selected</Button>
            <Button size="sm">Continue to Publish</Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table containerClassName="max-h-[70vh] overflow-y-auto overscroll-contain">
            <TableHeader className="sticky top-0 z-20 bg-card">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={(checked) => setRows((current) => current.map((row) => ({ ...row, selected: Boolean(checked) })))}
                    aria-label="Select all test cases"
                  />
                </TableHead>
                <TableHead>Test Case ID</TableHead>
                <TableHead className="min-w-[260px]">Editable Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Automation</TableHead>
                <TableHead className="min-w-[380px]">Editable Steps</TableHead>
                <TableHead className="min-w-[240px]">Expected Result</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className={cn("qa-table-row align-top", row.selected && "qa-table-row-selected")}>
                  <TableCell>
                    <Checkbox
                      checked={row.selected}
                      onCheckedChange={(checked) => patchRow(row.id, { selected: Boolean(checked) })}
                      aria-label={`Select ${row.id}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs font-semibold text-primary">{row.id}</TableCell>
                  <TableCell>
                    <InlineEditableText value={row.title} onChange={(value) => patchRow(row.id, { title: value })} ariaLabel={`${row.id} title`} />
                  </TableCell>
                  <TableCell><Badge variant="secondary">{row.type}</Badge></TableCell>
                  <TableCell><PriorityChip priority={row.priority} /></TableCell>
                  <TableCell><SeverityChip severity={row.severity} /></TableCell>
                  <TableCell><Badge variant="outline">{row.automationSuitability}</Badge></TableCell>
                  <TableCell>
                    <InlineEditableSteps steps={row.steps} onChange={(steps) => patchRow(row.id, { steps })} />
                  </TableCell>
                  <TableCell>
                    <InlineEditableText value={row.expectedResult} multiline onChange={(value) => patchRow(row.id, { expectedResult: value })} ariaLabel={`${row.id} expected result`} />
                  </TableCell>
                  <TableCell><Badge variant="outline">{row.coverage}</Badge></TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="icon-sm" variant="ghost" onClick={() => setActive(row)} aria-label={`Edit full details for ${row.id}`}>
                            <Edit className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit full details</TooltipContent>
                      </Tooltip>
                      <Button size="icon-sm" variant="ghost" onClick={() => duplicate(row)} aria-label={`Duplicate ${row.id}`}>
                        <Copy className="size-4" />
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))} aria-label={`Delete ${row.id}`}>
                        <Trash2 className="size-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
      <TestCaseEditDrawer
        testCase={active}
        open={Boolean(active)}
        onOpenChange={(open) => !open && setActive(null)}
        onSave={(updated) => {
          patchRow(updated.id, updated)
          setActive(null)
        }}
      />
    </>
  )
}

