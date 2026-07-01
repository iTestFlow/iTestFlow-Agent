"use client"

import { useMemo, useState } from "react"
import { Eye, Plus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { InlineEditableText } from "@/components/qa/inline-editable-text"
import { SeverityChip } from "@/components/qa/severity-chip"
import { cn } from "@/lib/utils"
import type { RequirementFinding } from "@/types/requirements"

export function RequirementFindingsTable({ findings }: { findings: RequirementFinding[] }) {
  const [rows, setRows] = useState(findings)
  const [showSelectedOnly, setShowSelectedOnly] = useState(false)

  const visibleRows = useMemo(
    () => (showSelectedOnly ? rows.filter((row) => row.selected) : rows),
    [rows, showSelectedOnly]
  )
  const selectedCount = rows.filter((row) => row.selected).length

  function patchRow(id: string, patch: Partial<RequirementFinding>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  return (
    <Card className="qa-card overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="text-sm text-muted-foreground">{selectedCount} findings selected for comment preview</div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setRows((current) => current.map((row) => ({ ...row, selected: true })))}>Select All</Button>
          <Button size="sm" variant="outline" onClick={() => setRows((current) => current.map((row) => ({ ...row, selected: false })))}>Deselect All</Button>
          <Button size="sm" variant={showSelectedOnly ? "default" : "outline"} onClick={() => setShowSelectedOnly((value) => !value)}>Show Selected Only</Button>
          <Button size="sm"><Eye className="size-3.5" />Preview Final Comment</Button>
          <Button size="sm" variant="outline"><Plus className="size-3.5" />Add Selected to Azure DevOps Comment</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table containerClassName="max-h-[70vh] overflow-y-auto overscroll-contain">
          <TableHeader className="sticky top-0 z-20 bg-card">
            <TableRow>
              <TableHead className="w-10">Select</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="min-w-[260px]">Finding</TableHead>
              <TableHead className="min-w-[320px]">Editable suggested improvement</TableHead>
              <TableHead>Impact</TableHead>
              <TableHead className="min-w-[220px]">Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRows.map((finding) => (
              <TableRow key={finding.id} className={cn("qa-table-row align-top", finding.selected && "qa-table-row-selected")}>
                <TableCell>
                  <Checkbox
                    checked={finding.selected}
                    onCheckedChange={(checked) => patchRow(finding.id, { selected: Boolean(checked) })}
                    aria-label={`Select finding ${finding.id}`}
                  />
                </TableCell>
                <TableCell><SeverityChip severity={finding.severity} /></TableCell>
                <TableCell><Badge variant="outline">{finding.category}</Badge></TableCell>
                <TableCell className="text-sm leading-6 text-foreground">{finding.finding}</TableCell>
                <TableCell>
                  <InlineEditableText
                    value={finding.suggestion}
                    multiline
                    onChange={(value) => patchRow(finding.id, { suggestion: value })}
                    ariaLabel={`${finding.id} suggestion`}
                  />
                </TableCell>
                <TableCell className="font-semibold text-foreground">{finding.impactScore}</TableCell>
                <TableCell className="text-xs leading-5 text-muted-foreground">{finding.sourceReference}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  )
}

