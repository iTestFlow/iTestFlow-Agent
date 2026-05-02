"use client"

import { useState } from "react"
import { Eye } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CoverageStatusChip } from "@/components/qa/coverage-status-chip"
import { PriorityChip } from "@/components/qa/priority-chip"
import { StatusChip } from "@/components/qa/status-chip"
import type { LinkedTestCase } from "@/types/test-cases"

export function LinkedTestCasesTable({ rows }: { rows: LinkedTestCase[] }) {
  const [active, setActive] = useState<LinkedTestCase | null>(null)

  return (
    <>
      <Card className="qa-card overflow-hidden">
        <div className="border-b border-[#EBECF0] p-4">
          <p className="text-sm text-[#626F86]">
            Existing linked Azure DevOps test cases only. Paste, upload, and import are intentionally not supported.
          </p>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Test Case ID</TableHead>
                <TableHead className="min-w-[280px]">Title</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Automation status</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Coverage</TableHead>
                <TableHead>Link relation</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id} className="qa-table-row">
                  <TableCell className="font-mono text-xs font-semibold text-[#0C66E4]">{row.id}</TableCell>
                  <TableCell className="font-medium text-[#172B4D]">{row.title}</TableCell>
                  <TableCell><StatusChip tone={row.state === "Ready" ? "success" : row.state === "Design" ? "draft" : "neutral"}>{row.state}</StatusChip></TableCell>
                  <TableCell><PriorityChip priority={row.priority} /></TableCell>
                  <TableCell><Badge variant="outline">{row.automationStatus}</Badge></TableCell>
                  <TableCell>{row.stepsCount}</TableCell>
                  <TableCell><CoverageStatusChip status={row.coverageStatus === "Partial" ? "Partial" : row.coverageStatus === "Gap" ? "Gap" : row.coverageStatus} /></TableCell>
                  <TableCell className="text-xs text-[#626F86]">{row.linkRelation}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon-sm" variant="ghost" onClick={() => setActive(row)} aria-label={`Open ${row.id}`}>
                      <Eye className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      <Sheet open={Boolean(active)} onOpenChange={(open) => !open && setActive(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{active?.id} - {active?.title}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 p-4 text-sm text-[#44546F]">
            <p>State: {active?.state}</p>
            <p>Automation status: {active?.automationStatus}</p>
            <p>Coverage status: {active?.coverageStatus}</p>
            <div className="rounded-lg border border-[#EBECF0] bg-[#F7F8FA] p-3">
              TODO: Fetch full linked Azure DevOps test case steps through the project-scoped adapter.
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

