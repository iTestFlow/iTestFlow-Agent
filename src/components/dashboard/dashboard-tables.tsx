"use client";

import { ExternalLink, SearchX } from "lucide-react";

import { StatusChip } from "@/components/qa/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type {
  DashboardBugRow,
  DashboardExecutionModuleRow,
  DashboardReleaseBlocker,
} from "@/types/dashboard";

export function TestingProgressTable({ rows }: { rows: DashboardExecutionModuleRow[] }) {
  return (
    <DashboardTableCard
      title="Testing Progress by Module"
      emptyMessage="No test execution data is available for the selected scope."
      hasRows={Boolean(rows.length)}
    >
      <Table className="min-w-[960px] table-fixed">
        <colgroup>
          <col className="w-[460px]" /><col className="w-[84px]" /><col className="w-[92px]" /><col className="w-[84px]" />
          <col className="w-[84px]" /><col className="w-[88px]" /><col className="w-[88px]" /><col className="w-[104px]" />
        </colgroup>
        <TableHeader><TableRow>
          <TableHead>Module / Suite</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Executed</TableHead>
          <TableHead className="text-right">Passed</TableHead><TableHead className="text-right">Failed</TableHead><TableHead className="text-right">Blocked</TableHead>
          <TableHead className="text-right">Not Run</TableHead><TableHead className="text-right">Pass Rate</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => <TableRow key={row.module}>
            <TableCell className="whitespace-normal break-words font-medium leading-5"><span className="line-clamp-2" title={row.module}>{row.module}</span></TableCell>
            <TableCell className="text-right tabular-nums">{row.total}</TableCell><TableCell className="text-right tabular-nums">{row.executed}</TableCell>
            <TableCell className="text-right tabular-nums">{row.passed}</TableCell><TableCell className="text-right tabular-nums">{row.failed}</TableCell>
            <TableCell className="text-right tabular-nums">{row.blocked}</TableCell><TableCell className="text-right tabular-nums">{row.notRun}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(row.passRate)}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

export function AgingBugsTable({ rows, title = "Unclosed Bug Aging" }: { rows: DashboardBugRow[]; title?: string }) {
  return (
    <DashboardTableCard
      title={title}
      emptyMessage="No bugs matched this view."
      hasRows={Boolean(rows.length)}
    >
      <Table className="min-w-[840px]">
        <TableHeader><TableRow>
          <TableHead>Bug</TableHead><TableHead>Severity</TableHead><TableHead>Priority</TableHead><TableHead>Status</TableHead>
          <TableHead className="text-right">Age</TableHead><TableHead>Linked Requirement</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => <TableRow key={row.id}>
            <TableCell className="min-w-[280px]"><WorkItemLink id={row.id} title={row.title} url={row.url} /></TableCell>
            <TableCell><SeverityChip value={row.severity} /></TableCell>
            <TableCell className="tabular-nums">{row.priority ?? "Unknown"}</TableCell><TableCell>{bugStatusLabel(row.status)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatAge(row.ageDays)}</TableCell>
            <TableCell className="max-w-[300px] whitespace-normal"><span className="line-clamp-2" title={row.linkedRequirementTitle ?? undefined}>{row.linkedRequirementId ? `${row.linkedRequirementId} - ${row.linkedRequirementTitle ?? "Requirement"}` : "None"}</span></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

export function ReleaseBlockersTable({
  rows,
  onViewAll,
  title = "Top Release Blockers",
  maxRows = 5,
}: {
  rows: DashboardReleaseBlocker[];
  onViewAll?: () => void;
  title?: string;
  maxRows?: number;
}) {
  return (
    <DashboardTableCard
      title={title}
      emptyMessage="No release blockers were identified by the configured rules."
      hasRows={Boolean(rows.length)}
      action={onViewAll && rows.length > maxRows ? <Button type="button" size="sm" variant="outline" onClick={onViewAll}>View all blockers</Button> : null}
    >
      <Table className="min-w-[880px]">
        <TableHeader><TableRow>
          <TableHead>Type</TableHead><TableHead>Item</TableHead><TableHead>Severity / Priority</TableHead>
          <TableHead className="text-right">Age</TableHead><TableHead>Recommended Action</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, maxRows).map((row, index) => <TableRow key={`${row.type}-${row.id}-${index}`}>
            <TableCell>{row.type}</TableCell><TableCell className="min-w-[280px]"><WorkItemLink id={row.id} title={row.title} url={row.url} /></TableCell>
            <TableCell><ReleaseRiskChip value={row.severityOrPriority} /></TableCell>
            <TableCell className="text-right tabular-nums">{formatAge(row.ageDays)}</TableCell><TableCell className="min-w-[280px] whitespace-normal">{row.recommendedAction}</TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

function DashboardTableCard({
  title,
  emptyMessage,
  hasRows,
  action,
  children,
}: {
  title: string;
  emptyMessage: string;
  hasRows: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="qa-card min-w-0 overflow-hidden">
      <CardHeader className="flex flex-col items-start justify-between gap-3 space-y-0 pb-3 lg:flex-row lg:items-center">
        <CardTitle className="text-base">{title}</CardTitle>
        {action ? <div className="max-w-full overflow-x-auto pb-0.5">{action}</div> : null}
      </CardHeader>
      <CardContent className="p-0">
        {hasRows ? <div className="max-h-[560px] overflow-auto border-t border-border [&_[data-slot=table-container]]:overflow-visible [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-muted/95 [&_thead]:shadow-[0_1px_0_hsl(var(--border))]">{children}</div> : (
          <div className="flex flex-col items-center border-t border-border px-6 py-9 text-center text-sm text-muted-foreground">
            <SearchX className="mb-2 size-4" aria-hidden="true" />
            {emptyMessage}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WorkItemLink({ id, title, url }: { id: string; title: string; url: string | null }) {
  const content = <><span className="font-mono text-xs text-muted-foreground">#{id}</span><span className="line-clamp-2">{title}</span></>;
  return url ? <a href={url} target="_blank" rel="noreferrer" className="group flex items-start gap-2 rounded-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">{content}<ExternalLink className="mt-0.5 size-3.5 shrink-0 opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /><span className="sr-only">(opens in a new tab)</span></a> : <div className="flex items-start gap-2 font-medium">{content}</div>;
}

function SeverityChip({ value }: { value: string }) {
  const tone = value === "Critical" || value === "High" ? "error" : value === "Medium" ? "warning" : value === "Low" ? "success" : "neutral";
  return <StatusChip tone={tone}>{value}</StatusChip>;
}

function ReleaseRiskChip({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const tone = normalized.includes("critical") || normalized.includes("high") || normalized.includes("priority 1")
    ? "error"
    : normalized.includes("medium") || normalized.includes("priority 2")
      ? "warning"
      : "neutral";
  return <StatusChip tone={tone}>{value}</StatusChip>;
}

function formatPercent(value: number | null) {
  return value === null ? "Unknown" : `${value}%`;
}

function formatAge(value: number | null) {
  return value === null ? "Unknown" : `${value}d`;
}

function bugStatusLabel(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === "resolved" || normalized === "fixed" ? `${value} / Pending Verification` : value;
}
