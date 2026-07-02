"use client"

import { useState } from "react"
import { Eye } from "lucide-react"

import { Button } from "@/components/ui/button"
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
import { StatusChip } from "@/components/qa/status-chip"
import { formatDateTime } from "@/shared/lib/utils"
import type { AuditLog } from "@/types/audit"

export function AuditLogTable({ logs }: { logs: AuditLog[] }) {
  const [active, setActive] = useState<AuditLog | null>(null)

  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
          <Table containerClassName="max-h-[70vh] overflow-y-auto overscroll-contain">
            <TableHeader className="sticky top-0 z-20 bg-card">
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>User/local profile</TableHead>
                <TableHead>Details</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id} className="qa-table-row">
                  <TableCell>{formatDateTime(log.timestamp)}</TableCell>
                  <TableCell className="font-medium text-foreground">{log.action}</TableCell>
                  <TableCell className="font-mono text-xs text-primary">{log.entity}</TableCell>
                  <TableCell>{log.projectId}</TableCell>
                  <TableCell><StatusChip tone={log.status === "Success" ? "success" : log.status === "Warning" ? "warning" : log.status === "Failed" ? "error" : "draft"}>{log.status}</StatusChip></TableCell>
                  <TableCell>{log.user}</TableCell>
                  <TableCell className="max-w-sm truncate text-muted-foreground">{log.details}</TableCell>
                  <TableCell className="text-right">
                    <Button size="icon-sm" variant="ghost" onClick={() => setActive(log)} aria-label={`View ${log.id}`}>
                      <Eye className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        <div className="flex items-center justify-between border-t border-border px-4 py-3 text-sm text-muted-foreground">
          <span>Page 1 of 1</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled>Previous</Button>
            <Button size="sm" variant="outline" disabled>Next</Button>
          </div>
        </div>
      </div>

      <Sheet open={Boolean(active)} onOpenChange={(open) => !open && setActive(null)}>
        <SheetContent className="sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>{active?.action}</SheetTitle>
          </SheetHeader>
          <div className="space-y-4 p-4 text-sm text-muted-foreground">
            <Info label="Run ID" value={active?.runId ?? ""} />
            <Info label="Details" value={active?.details ?? ""} />
            <Info label="Payload summary" value={active?.payloadSummary ?? ""} />
            {active?.errorDetails ? <Info label="Error details" value={active.errorDetails} /> : null}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted p-3">
      <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">{label}</div>
      <div className="mt-1 leading-6 text-foreground">{value}</div>
    </div>
  )
}
