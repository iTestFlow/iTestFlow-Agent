"use client";

import { ArrowUpDown, ExternalLink, SearchX } from "lucide-react";
import { useMemo, useState } from "react";

import { StatusChip } from "@/components/qa/status-chip";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type {
  DashboardBlockerRow,
  DashboardBugRow,
  DashboardExecutionHealth,
  DashboardExecutionModuleRow,
  DashboardReleaseBlocker,
  DashboardRequirementRow,
  DashboardRiskStatus,
} from "@/types/dashboard";

type TestingFilter = "all" | "critical" | "high" | "blocked" | "low-pass-rate";
type BugFilter = "all" | "critical-high" | "new" | "pending-verification" | "oldest";
type CoverageFilter = "all" | "not-covered" | "no-tests" | "high-risk" | "missing-criteria";

const testingFilters: Array<QuickFilterOption<TestingFilter>> = [
  { value: "all", label: "All" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "blocked", label: "Blocked" },
  { value: "low-pass-rate", label: "Low Pass Rate" },
];

const bugFilters: Array<QuickFilterOption<BugFilter>> = [
  { value: "all", label: "All" },
  { value: "critical-high", label: "Critical / High" },
  { value: "new", label: "New" },
  { value: "pending-verification", label: "Pending Verification" },
  { value: "oldest", label: "Oldest" },
];

const coverageFilters: Array<QuickFilterOption<CoverageFilter>> = [
  { value: "all", label: "All" },
  { value: "not-covered", label: "Not Covered" },
  { value: "no-tests", label: "No Tests" },
  { value: "high-risk", label: "High Risk" },
  { value: "missing-criteria", label: "Missing Criteria" },
];

export function TestingProgressTable({ rows }: { rows: DashboardExecutionModuleRow[] }) {
  const [filter, setFilter] = useState<TestingFilter>("all");
  const filteredRows = useMemo(() => rows.filter((row) => {
    if (filter === "critical") return row.status === "critical";
    if (filter === "high") return row.status === "high";
    if (filter === "blocked") return row.blocked > 0;
    if (filter === "low-pass-rate") return row.passRate !== null && row.passRate < 80;
    return true;
  }), [filter, rows]);

  return (
    <DashboardTableCard
      title="Testing Progress by Module"
      emptyMessage={rows.length ? "No modules match this quick filter." : "No test execution data is available for the selected scope."}
      hasRows={Boolean(filteredRows.length)}
      action={<QuickFilterGroup label="Filter testing progress" value={filter} onChange={setFilter} options={testingFilters} />}
    >
      <Table className="min-w-[1080px] table-fixed">
        <colgroup>
          <col className="w-[420px]" /><col className="w-[78px]" /><col className="w-[86px]" /><col className="w-[78px]" />
          <col className="w-[78px]" /><col className="w-[82px]" /><col className="w-[82px]" /><col className="w-[92px]" /><col className="w-[104px]" />
        </colgroup>
        <TableHeader><TableRow>
          <TableHead>Module / Suite</TableHead><TableHead className="text-right">Total</TableHead><TableHead className="text-right">Executed</TableHead>
          <TableHead className="text-right">Passed</TableHead><TableHead className="text-right">Failed</TableHead><TableHead className="text-right">Blocked</TableHead>
          <TableHead className="text-right">Not Run</TableHead><TableHead className="text-right">Pass Rate</TableHead><TableHead>Status</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {filteredRows.map((row) => <TableRow key={row.module} className={row.status === "critical" ? "border-l-2 border-l-destructive bg-destructive/5" : row.status === "high" ? "border-l-2 border-l-warning bg-warning/5" : undefined}>
            <TableCell className="whitespace-normal break-words font-medium leading-5"><span className="line-clamp-2" title={row.module}>{row.module}</span></TableCell>
            <TableCell className="text-right tabular-nums">{row.total}</TableCell><TableCell className="text-right tabular-nums">{row.executed}</TableCell>
            <TableCell className="text-right tabular-nums">{row.passed}</TableCell><TableCell className="text-right tabular-nums">{row.failed}</TableCell>
            <TableCell className="text-right tabular-nums">{row.blocked}</TableCell><TableCell className="text-right tabular-nums">{row.notRun}</TableCell>
            <TableCell className="text-right tabular-nums">{formatPercent(row.passRate)}</TableCell><TableCell><RiskChip risk={row.status} /></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

export function AgingBugsTable({ rows, title = "Unclosed Bug Aging", compactEmpty = false }: { rows: DashboardBugRow[]; title?: string; compactEmpty?: boolean }) {
  const [filter, setFilter] = useState<BugFilter>("all");
  const filteredRows = useMemo(() => {
    const matching = rows.filter((row) => {
      const status = row.status.trim().toLowerCase();
      if (filter === "critical-high") return row.severity === "Critical" || row.severity === "High";
      if (filter === "new") return status === "new";
      if (filter === "pending-verification") return status === "resolved" || status === "fixed";
      return true;
    });
    return filter === "oldest"
      ? [...matching].sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
      : matching;
  }, [filter, rows]);

  return (
    <DashboardTableCard
      title={title}
      emptyMessage={rows.length ? "No bugs match this quick filter." : "No bugs matched this view."}
      hasRows={Boolean(filteredRows.length)}
      compactEmpty={compactEmpty}
      action={<QuickFilterGroup label={`Filter ${title}`} value={filter} onChange={setFilter} options={bugFilters} />}
    >
      <Table className="min-w-[960px]">
        <TableHeader><TableRow>
          <TableHead>Bug</TableHead><TableHead>Severity</TableHead><TableHead>Priority</TableHead><TableHead>Status</TableHead>
          <TableHead>Assignee</TableHead><TableHead className="text-right">Age</TableHead><TableHead>Linked Requirement</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {filteredRows.map((row) => <TableRow key={row.id}>
            <TableCell className="min-w-[280px]"><WorkItemLink id={row.id} title={row.title} url={row.url} /></TableCell>
            <TableCell><SeverityChip value={row.severity} /></TableCell>
            <TableCell className="tabular-nums">{row.priority ?? "Unknown"}</TableCell><TableCell>{bugStatusLabel(row.status)}</TableCell>
            <TableCell>{row.assignee ?? "Unassigned"}</TableCell><TableCell className="text-right tabular-nums">{formatAge(row.ageDays)}</TableCell>
            <TableCell className="max-w-[300px] whitespace-normal"><span className="line-clamp-2" title={row.linkedRequirementTitle ?? undefined}>{row.linkedRequirementId ? `${row.linkedRequirementId} - ${row.linkedRequirementTitle ?? "Requirement"}` : "None"}</span></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

export function CoverageMatrixTable({ rows, title = "Requirement-to-Test Coverage Matrix" }: { rows: DashboardRequirementRow[]; title?: string }) {
  const [filter, setFilter] = useState<CoverageFilter>("all");
  const showQuickFilters = title === "Coverage Gaps";
  const filteredRows = useMemo(() => rows.filter((row) => {
    if (!showQuickFilters || filter === "all") return true;
    if (filter === "not-covered") return row.coverageStatus === "not_covered";
    if (filter === "no-tests") return row.testCasesCount === 0;
    if (filter === "high-risk") return row.riskStatus === "critical" || row.riskStatus === "high";
    if (filter === "missing-criteria") return !row.acceptanceCriteriaPresent;
    return true;
  }), [filter, rows, showQuickFilters]);

  return (
    <DashboardTableCard
      title={title}
      emptyMessage={rows.length ? "No requirements match this quick filter." : "No requirement coverage data is available for the selected filters."}
      hasRows={Boolean(filteredRows.length)}
      action={showQuickFilters ? <QuickFilterGroup label="Filter coverage gaps" value={filter} onChange={setFilter} options={coverageFilters} /> : undefined}
    >
      <Table className="min-w-[1320px]">
        <TableHeader><TableRow>
          <TableHead>Requirement</TableHead><TableHead>Priority</TableHead><TableHead>Module</TableHead><TableHead>Acceptance Criteria</TableHead>
          <TableHead className="text-right">Tests</TableHead><TableHead className="text-right">Passed</TableHead><TableHead className="text-right">Failed</TableHead>
          <TableHead className="text-right">Blocked</TableHead><TableHead className="text-right">Not Run</TableHead><TableHead>Coverage Status</TableHead>
          <TableHead>Execution Health</TableHead><TableHead>Risk Status</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {filteredRows.map((row) => <TableRow key={row.id} className={row.riskStatus === "critical" ? "border-l-2 border-l-destructive bg-destructive/5" : row.riskStatus === "high" ? "border-l-2 border-l-warning bg-warning/5" : undefined}>
            <TableCell className="min-w-[300px]"><WorkItemLink id={row.id} title={row.title} url={row.url} /></TableCell>
            <TableCell className="tabular-nums">{row.priority ?? "Unknown"}</TableCell><TableCell className="max-w-[220px] whitespace-normal"><span className="line-clamp-2" title={row.module}>{row.module}</span></TableCell>
            <TableCell>{row.acceptanceCriteriaPresent ? "Yes" : "No"}</TableCell>
            <TableCell className="text-right tabular-nums">{row.testCasesCount}</TableCell><TableCell className="text-right tabular-nums">{row.passed}</TableCell>
            <TableCell className="text-right tabular-nums">{row.failed}</TableCell><TableCell className="text-right tabular-nums">{row.blocked}</TableCell>
            <TableCell className="text-right tabular-nums">{row.notRun}</TableCell><TableCell><CoverageChip value={row.coverageStatus} /></TableCell>
            <TableCell><ExecutionHealthChip value={row.executionHealth} /></TableCell><TableCell><RiskChip risk={row.riskStatus} /></TableCell>
          </TableRow>)}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

type BlockerSortKey = "age" | "owner" | "reason" | "area";

export function BlockersTable({ rows }: { rows: DashboardBlockerRow[] }) {
  const [sort, setSort] = useState<{ key: BlockerSortKey; direction: "asc" | "desc" }>({ key: "age", direction: "desc" });
  const sortedRows = useMemo(() => [...rows].sort((a, b) => {
    const direction = sort.direction === "asc" ? 1 : -1;
    if (sort.key === "age") return ((a.ageDays ?? -1) - (b.ageDays ?? -1)) * direction;
    const aValue = sort.key === "owner" ? a.owner : sort.key === "reason" ? a.reason : a.impactedArea;
    const bValue = sort.key === "owner" ? b.owner : sort.key === "reason" ? b.reason : b.impactedArea;
    return (aValue ?? "").localeCompare(bValue ?? "") * direction;
  }), [rows, sort]);

  function sortBy(key: BlockerSortKey) {
    setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  }

  return (
    <DashboardTableCard title="Blocker Aging" emptyMessage="No blocked tests are present in the selected execution scope." hasRows={Boolean(rows.length)}>
      <Table className="min-w-[1180px]">
        <TableHeader><TableRow>
          <TableHead>Test</TableHead><SortableHead label="Reason" onClick={() => sortBy("reason")} /><SortableHead label="Owner" onClick={() => sortBy("owner")} />
          <SortableHead label="Age" onClick={() => sortBy("age")} align="right" /><SortableHead label="Impacted Module / Suite" onClick={() => sortBy("area")} />
          <TableHead>Status</TableHead><TableHead>Recommended Action</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {sortedRows.map((row) => <TableRow key={row.id}>
            <TableCell className="min-w-[280px]"><WorkItemLink id={row.id} title={row.title} url={row.url} /></TableCell>
            <TableCell className="max-w-[240px] whitespace-normal"><span className="line-clamp-2" title={row.reason}>{row.reason}</span></TableCell><TableCell>{row.owner ?? "Unassigned"}</TableCell>
            <TableCell className="text-right tabular-nums">{formatAge(row.ageDays)}</TableCell><TableCell className="max-w-[240px] whitespace-normal"><span className="line-clamp-2" title={row.impactedArea ?? undefined}>{row.impactedArea ?? "Unknown"}</span></TableCell>
            <TableCell><StatusChip tone="warning">{row.status}</StatusChip></TableCell><TableCell className="min-w-[300px] whitespace-normal">{row.recommendedAction}</TableCell>
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
      <Table className="min-w-[1040px]">
        <TableHeader><TableRow>
          <TableHead>Type</TableHead><TableHead>Item</TableHead><TableHead>Severity / Priority</TableHead><TableHead>Owner</TableHead>
          <TableHead className="text-right">Age</TableHead><TableHead>Recommended Action</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.slice(0, maxRows).map((row, index) => <TableRow key={`${row.type}-${row.id}-${index}`}>
            <TableCell>{row.type}</TableCell><TableCell className="min-w-[280px]"><WorkItemLink id={row.id} title={row.title} url={row.url} /></TableCell>
            <TableCell><ReleaseRiskChip value={row.severityOrPriority} /></TableCell><TableCell>{row.owner ?? "Unassigned"}</TableCell>
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
  compactEmpty = false,
  children,
}: {
  title: string;
  emptyMessage: string;
  hasRows: boolean;
  action?: React.ReactNode;
  compactEmpty?: boolean;
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
          <div className={`flex flex-col items-center border-t border-border px-6 text-center text-sm text-muted-foreground ${compactEmpty ? "py-4" : "py-9"}`}>
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

function SortableHead({ label, onClick, align }: { label: string; onClick: () => void; align?: "right" }) {
  return (
    <TableHead className={align === "right" ? "text-right" : undefined}>
      <button type="button" className={`inline-flex items-center gap-1 rounded-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring ${align === "right" ? "ml-auto" : ""}`} onClick={onClick}>
        {label}<ArrowUpDown className="size-3" />
      </button>
    </TableHead>
  );
}

type QuickFilterOption<T extends string> = {
  value: T;
  label: string;
};

function QuickFilterGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<QuickFilterOption<T>>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex min-w-max items-center gap-1 rounded-lg border border-border bg-muted/40 p-1" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          className="h-7 rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RiskChip({ risk }: { risk: DashboardRiskStatus }) {
  const tone = risk === "critical" || risk === "high" ? "error" : risk === "medium" ? "warning" : risk === "low" ? "success" : "neutral";
  return <StatusChip tone={tone}>{titleCase(risk)}</StatusChip>;
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

function CoverageChip({ value }: { value: DashboardRequirementRow["coverageStatus"] }) {
  const tone = value === "covered" ? "success" : value === "partially_covered" ? "warning" : value === "not_covered" ? "error" : "neutral";
  return <StatusChip tone={tone}>{titleCase(value)}</StatusChip>;
}

function ExecutionHealthChip({ value }: { value: DashboardExecutionHealth }) {
  const tone = value === "passing" ? "success" : value === "failing" ? "error" : value === "blocked" || value === "mixed" ? "warning" : "neutral";
  return <StatusChip tone={tone}>{titleCase(value)}</StatusChip>;
}

function titleCase(value: string) {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
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
