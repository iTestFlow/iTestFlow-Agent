import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CoverageStatusChip } from "@/components/qa/coverage-status-chip"
import type { CoverageMatrixRow } from "@/types/coverage"

export function CoverageMatrixTable({
  rows,
  testCaseIds,
}: {
  rows: CoverageMatrixRow[]
  testCaseIds: string[]
}) {
  return (
    <Card className="qa-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[#EBECF0] p-4">
        <div className="text-sm text-[#626F86]">Acceptance criteria rows by test case coverage columns</div>
        <Button size="sm" variant="outline">Export</Button>
      </div>
      <ScrollArea className="w-full whitespace-nowrap">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="sticky left-0 z-10 min-w-[360px] bg-[#EDF2F7]">Acceptance Criteria</TableHead>
              {testCaseIds.map((id) => (
                <TableHead key={id} className="min-w-[190px] text-center font-mono text-xs">{id}</TableHead>
              ))}
              <TableHead className="min-w-[260px]">Gap</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.criterion.id} className="qa-table-row">
                <TableCell className="sticky left-0 z-10 max-w-[360px] whitespace-normal bg-white">
                  <div className="flex items-start gap-3">
                    <Badge variant="outline">{row.criterion.id}</Badge>
                    <div>
                      <div className="text-sm font-medium text-[#172B4D]">{row.criterion.text}</div>
                      <div className="mt-1 text-xs text-[#626F86]">Priority {row.criterion.priority}</div>
                    </div>
                  </div>
                </TableCell>
                {testCaseIds.map((id) => {
                  const cell = row.cells.find((item) => item.testCaseId === id)
                  return (
                    <TableCell key={id} className="text-center">
                      {cell ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="inline-flex">
                              <CoverageStatusChip status={cell.status} />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{cell.note}</TooltipContent>
                        </Tooltip>
                      ) : (
                        <CoverageStatusChip status="Not applicable" />
                      )}
                    </TableCell>
                  )
                })}
                <TableCell className="whitespace-normal text-sm text-[#44546F]">{row.gap}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </Card>
  )
}

