"use client";

import {
  AlertTriangle,
  BriefcaseBusiness,
  Clock3,
  ExternalLink,
  Filter,
  ListChecks,
  RefreshCw,
  TimerReset,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AutoRefreshStatus } from "@/components/dashboard/auto-refresh-status";
import { DashboardChartCard, DistributionBarChart, DonutChart } from "@/components/dashboard/dashboard-visualizations";
import { EmptyState } from "@/components/qa/empty-state";
import { ErrorState } from "@/components/qa/error-state";
import { LoadingState } from "@/components/qa/loading-state";
import { MetricCard } from "@/components/qa/metric-card";
import { StatusChip } from "@/components/qa/status-chip";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useActiveProject } from "@/shared/lib/use-active-project";
import { useDashboardRefresh } from "@/shared/lib/use-dashboard-refresh";
import type {
  MyWorkbenchAnalytics,
  WorkbenchCard,
  WorkbenchFilterMetadata,
  WorkbenchFilters,
  WorkbenchFocusBadge,
  WorkbenchFocusItem,
  WorkbenchRiskStatus,
} from "@/types/my-workbench-dashboard";

type WorkbenchState = {
  loading: boolean;
  error: string | null;
  data: MyWorkbenchAnalytics | null;
};

const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
const STALE_THRESHOLD_MS = 2 * 60_000;
const FILTER_SETTLE_MS = 1_500;

const defaultWorkbenchFilters: WorkbenchFilters = {
  sprintMode: "current",
  iterationPath: null,
  workItemTypes: [],
  states: [],
  parentIds: [],
  priority: "all",
  areaPath: null,
  includeCompleted: false,
  includeBacklog: false,
};

const emptyMetadata: WorkbenchFilterMetadata = {
  iterations: [],
  areas: [],
  workItemTypes: [],
  states: [],
  parents: [],
};

export function MyWorkbenchDashboardClient({ active }: { active: boolean }) {
  const scope = useActiveProject();
  const previousProjectId = useRef<string | null>(null);
  const [filters, setFilters] = useState<WorkbenchFilters>(defaultWorkbenchFilters);
  const [state, setState] = useState<WorkbenchState>({ loading: true, error: null, data: null });

  const requestBody = useMemo(() => ({ scope, filters }), [filters, scope]);

  const {
    refreshToken,
    fetching,
    refreshFailed,
    setRefreshFailed,
    nextRefreshAt,
    triggerRefresh,
    markInteracting,
    beginFetch,
    settleFetch,
  } = useDashboardRefresh({
    enabled: active && Boolean(scope) && Boolean(state.data),
    loading: state.loading,
    intervalMs: AUTO_REFRESH_INTERVAL_MS,
    staleMs: STALE_THRESHOLD_MS,
    filterSettleMs: FILTER_SETTLE_MS,
  });

  useEffect(() => {
    const projectId = scope?.azureProjectId ?? null;
    if (projectId !== previousProjectId.current) {
      previousProjectId.current = projectId;
      setFilters(defaultWorkbenchFilters);
      setState({ loading: Boolean(scope), error: null, data: null });
      setRefreshFailed(false);
    }
  }, [scope, setRefreshFailed]);

  useEffect(() => {
    if (!active) return;
    if (scope === undefined) return;
    if (!scope) {
      setState({ loading: false, error: null, data: null });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      const background = beginFetch();
      if (!background) {
        setState((current) => ({ ...current, loading: true, error: null }));
      }
      try {
        const response = await fetch("/api/dashboard/my-workbench", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
          cache: "no-store",
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Could not load your Azure DevOps assigned work.");
        setState({ loading: false, error: null, data: json as MyWorkbenchAnalytics });
        setRefreshFailed(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (background) {
          setRefreshFailed(true);
        } else {
          setState((current) => ({
            loading: false,
            error: error instanceof Error ? error.message : "Could not load your Azure DevOps assigned work.",
            data: current.data,
          }));
        }
      } finally {
        if (!controller.signal.aborted) {
          settleFetch();
        }
      }
    })();
    return () => controller.abort();
  }, [active, requestBody, refreshToken, scope, beginFetch, settleFetch, setRefreshFailed]);

  function handleFiltersChange(next: WorkbenchFilters) {
    setFilters(next);
    markInteracting();
  }

  if (scope === undefined) return <LoadingState rows={8} />;
  if (!scope) {
    return <EmptyState title="Select an Azure DevOps project" description="Use the project selector in the top bar to load your assigned Azure DevOps work." />;
  }

  const data = state.data;
  const metadata = data?.filterMetadata ?? emptyMetadata;

  return (
    <div className="space-y-4">
      <section className="space-y-1">
        <h2 className="text-lg font-semibold text-foreground">My Workbench</h2>
        <p className="text-sm text-muted-foreground">Track your assigned Azure DevOps work, sprint focus, remaining hours, states, and priorities.</p>
      </section>

      <WorkbenchFilters
        value={filters}
        metadata={metadata}
        selectedSprint={data?.metadata.selectedSprint ?? null}
        disabled={state.loading && !data}
        onChange={handleFiltersChange}
      />

      <WorkbenchScopeBar
        projectName={scope.azureProjectName}
        data={data}
        filters={filters}
        loading={state.loading}
        refreshing={fetching}
        refreshFailed={refreshFailed}
        nextRefreshAt={nextRefreshAt}
        onRefresh={() => triggerRefresh(false)}
      />

      {state.error ? <ErrorState title="My Workbench refresh failed" message={state.error} onRetry={() => triggerRefresh(false)} /> : null}
      {data?.metadata.warnings.length ? <WorkbenchWarnings warnings={data.metadata.warnings} /> : null}

      {!data && state.loading ? <LoadingState rows={8} /> : null}
      {data ? (
        <>
          <p className="text-xs leading-5 text-muted-foreground">Showing work assigned to you for the selected project and sprint.</p>
          <WorkbenchCardGrid cards={data.cards} />
          <MyFocusListTable rows={data.focusList} />
          <div className="grid gap-4 xl:grid-cols-2">
            <DashboardChartCard
              title="Remaining Work by Status"
              description="Remaining hours grouped by Azure DevOps state."
              hasData={data.charts.remainingWorkByStatus.some((item) => item.value > 0)}
              emptyMessage="No estimated remaining work is available for this scope."
              summary={chartSummary(data.charts.remainingWorkByStatus)}
            >
              <DistributionBarChart data={data.charts.remainingWorkByStatus} />
            </DashboardChartCard>
            <DashboardChartCard
              title="Sprint Burn Status"
              description="MVP fallback: ideal remaining work with the current remaining-work snapshot."
              hasData={Boolean(data.charts.sprintBurnStatus.length)}
              emptyMessage="Select a sprint with estimates to view burn status."
            >
              <SprintBurnChart data={data.charts.sprintBurnStatus} />
            </DashboardChartCard>
          </div>
          <AssignedWorkBySprintTable rows={data.assignedBySprint} />
          <DashboardChartCard
            title="Work Items by Type"
            description="Assigned work item mix using original Azure DevOps type names, including custom types."
            hasData={data.charts.workItemsByType.some((item) => item.value > 0)}
            emptyMessage="No assigned work item types are available for this scope."
            summary={chartSummary(data.charts.workItemsByType)}
          >
            <DonutChart data={data.charts.workItemsByType} centerLabel="Items" />
          </DashboardChartCard>
        </>
      ) : null}
    </div>
  );
}

function WorkbenchFilters({
  value,
  metadata,
  selectedSprint,
  disabled,
  onChange,
}: {
  value: WorkbenchFilters;
  metadata: WorkbenchFilterMetadata;
  selectedSprint: MyWorkbenchAnalytics["metadata"]["selectedSprint"] | null;
  disabled: boolean;
  onChange: (value: WorkbenchFilters) => void;
}) {
  const [moreFiltersOpen, setMoreFiltersOpen] = useState(false);
  const activeAdvanced = Boolean(
    value.areaPath ||
    value.priority !== "all" ||
    value.includeCompleted ||
    value.includeBacklog,
  );

  function patch(next: Partial<WorkbenchFilters>) {
    onChange({ ...value, ...next });
  }

  function setIncludeCompleted(includeCompleted: boolean) {
    patch({ includeCompleted });
  }

  const selectedIterationPath = value.iterationPath ?? selectedSprint?.path ?? metadata.iterations.find((iteration) => iteration.category === "current")?.value ?? metadata.iterations[0]?.value ?? "";
  const selectedIteration = metadata.iterations.find((iteration) => iteration.value === selectedIterationPath);

  return (
    <section className="qa-card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.85fr)_minmax(0,0.85fr)_minmax(0,1fr)_auto] xl:items-start">
        <div className="space-y-1.5">
          <Label htmlFor="workbench-iteration" className="text-sm font-semibold text-foreground">Sprint</Label>
          <select
            id="workbench-iteration"
            className="focus-ring h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
            value={selectedIterationPath}
            onChange={(event) => patch({ sprintMode: "custom", iterationPath: event.target.value || null })}
            disabled={disabled || !metadata.iterations.length}
          >
            <option value="">{metadata.iterations.length ? "Select sprint" : "Loading sprints..."}</option>
            {metadata.iterations.map((iteration) => (
              <option key={iteration.value} value={iteration.value}>
                {iteration.label}
              </option>
            ))}
          </select>
          {selectedIteration ? (
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              {selectedIteration.category === "current" ? <Badge variant="outline">Current sprint</Badge> : null}
              {selectedIteration.startDate ? <Badge variant="secondary">Start {formatDateCell(selectedIteration.startDate)}</Badge> : null}
              {selectedIteration.finishDate ? <Badge variant="secondary">Finish {formatDateCell(selectedIteration.finishDate)}</Badge> : null}
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">Work item type</Label>
          <SearchableMultiSelect
            options={metadata.workItemTypes}
            value={value.workItemTypes}
            onValueChange={(workItemTypes) => patch({ workItemTypes })}
            getOptionValue={(option) => option.value}
            getOptionLabel={(option) => option.label}
            disabled={disabled || !metadata.workItemTypes.length}
            placeholder="All assigned types"
            searchPlaceholder="Search work item types"
            triggerClassName="h-10"
            ariaLabel="Workbench work item types"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">State</Label>
          <SearchableMultiSelect
            options={metadata.states}
            value={value.states}
            onValueChange={(states) => patch({ states })}
            getOptionValue={(option) => option.value}
            getOptionLabel={(option) => option.label}
            disabled={disabled || !metadata.states.length}
            placeholder="All states"
            searchPlaceholder="Search states"
            triggerClassName="h-10"
            ariaLabel="Workbench states"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm font-semibold text-foreground">Parent</Label>
          <SearchableMultiSelect
            options={metadata.parents}
            value={value.parentIds}
            onValueChange={(parentIds) => patch({ parentIds })}
            getOptionValue={(option) => option.value}
            getOptionLabel={(option) => option.label}
            getOptionSearchText={(option) => `${option.label} ${option.description ?? ""}`}
            disabled={disabled || !metadata.parents.length}
            placeholder="All parents"
            searchPlaceholder="Search parents"
            triggerClassName="h-10"
            contentClassName="w-[460px]"
            ariaLabel="Workbench parents"
          />
        </div>

        <Popover open={moreFiltersOpen} onOpenChange={setMoreFiltersOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" className="mt-6 h-10 justify-start gap-2 whitespace-nowrap px-3" disabled={disabled}>
              <Filter className="size-4" />
              More filters{activeAdvanced ? " (active)" : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(760px,calc(100vw-2rem))] space-y-3 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <SearchableCombobox
                value={value.areaPath ?? ""}
                selectedLabel={value.areaPath ?? "All areas"}
                options={[{ value: "__all__", label: "All areas" }, ...metadata.areas]}
                onValueChange={(areaPath) => patch({ areaPath: areaPath === "__all__" ? null : areaPath })}
                disabled={disabled}
                placeholder="All areas"
                searchPlaceholder="Search areas"
                ariaLabel="Area Path"
              />
              <Select value={value.priority} onValueChange={(priority) => patch({ priority: priority as WorkbenchFilters["priority"] })} disabled={disabled}>
                <SelectTrigger aria-label="Priority"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="1">Priority 1</SelectItem>
                  <SelectItem value="2">Priority 2</SelectItem>
                  <SelectItem value="3">Priority 3</SelectItem>
                  <SelectItem value="4">Priority 4</SelectItem>
                  <SelectItem value="none">No priority</SelectItem>
                </SelectContent>
              </Select>
              <div className="grid gap-2 rounded-md border border-border p-3">
                <CheckboxRow
                  id="include-completed"
                  label="Include completed items"
                  checked={value.includeCompleted}
                  disabled={disabled}
                  onCheckedChange={setIncludeCompleted}
                />
                <CheckboxRow
                  id="include-backlog"
                  label="Include backlog/no sprint items"
                  checked={value.includeBacklog}
                  disabled={disabled}
                  onCheckedChange={(includeBacklog) => patch({ includeBacklog })}
                />
              </div>
            </div>
            {activeAdvanced ? (
              <div className="flex justify-end">
                <Button type="button" size="sm" variant="ghost" onClick={() => onChange({ ...value, areaPath: null, priority: "all", includeCompleted: false, includeBacklog: false })}>
                  <X className="size-4" />Clear advanced filters
                </Button>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>
    </section>
  );
}

function CheckboxRow({
  id,
  label,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Label htmlFor={id} className="flex cursor-pointer items-center gap-2 text-sm font-medium">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(nextChecked) => onCheckedChange(nextChecked === true)}
      />
      {label}
    </Label>
  );
}

function WorkbenchScopeBar({
  projectName,
  data,
  filters,
  loading,
  refreshing,
  refreshFailed,
  nextRefreshAt,
  onRefresh,
}: {
  projectName: string;
  data: MyWorkbenchAnalytics | null;
  filters: WorkbenchFilters;
  loading: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  nextRefreshAt: number | null;
  onRefresh: () => void;
}) {
  const selectedSprint = data?.metadata.selectedSprint;
  const chips = [
    selectedSprint?.path ?? sprintModeLabel(selectedSprint?.mode ?? filters.sprintMode),
    filters.includeCompleted ? "Completed included" : "Open work",
    filters.includeBacklog ? "Backlog included" : "Sprint work",
  ];
  if (filters.areaPath) chips.push(filters.areaPath);
  if (filters.priority !== "all") chips.push(filters.priority === "none" ? "No priority" : `Priority ${filters.priority}`);

  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Personal Scope</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-foreground">{projectName}</div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {data ? `Assigned to ${data.user.displayName}` : "Loading your assigned Azure DevOps work."}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex flex-wrap gap-1.5">{chips.slice(0, 5).map((chip) => <Badge key={chip} variant="secondary" className="font-normal">{chip}</Badge>)}</div>
          <div className="flex shrink-0 items-center gap-2">
            <AutoRefreshStatus generatedAt={data?.generatedAt} nextRefreshAt={nextRefreshAt} refreshing={refreshing} failed={refreshFailed} />
            <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />Refresh
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function WorkbenchWarnings({ warnings }: { warnings: string[] }) {
  return (
    <div className="flex min-h-9 items-center gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-1.5 text-sm">
      <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-foreground" title={warnings[0]}>
        <span className="font-medium">Data limitation:</span> {warnings[0]}
      </p>
      {warnings.length > 1 ? <span className="shrink-0 text-xs font-semibold text-muted-foreground">+{warnings.length - 1}</span> : null}
    </div>
  );
}

function WorkbenchCardGrid({ cards }: { cards: WorkbenchCard[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {cards.map((card) => (
        <MetricCard
          key={card.key}
          title={card.title}
          value={card.value}
          description={card.subtitle}
          icon={cardIcon(card.key)}
          tone={card.tone}
        />
      ))}
    </div>
  );
}

function MyFocusListTable({ rows }: { rows: WorkbenchFocusItem[] }) {
  return (
    <DashboardTableCard
      title="My Focus List"
      emptyMessage="No assigned work found for the selected sprint. You have no open Azure DevOps work items assigned in this scope."
      hasRows={Boolean(rows.length)}
    >
      <Table className="min-w-[1280px]">
        <TableHeader><TableRow>
          <TableHead>Focus</TableHead><TableHead>ID</TableHead><TableHead>Title</TableHead><TableHead>Type</TableHead><TableHead>State</TableHead>
          <TableHead>Parent</TableHead><TableHead>Sprint</TableHead><TableHead className="text-right">Remaining</TableHead>
          <TableHead className="text-right">Completed</TableHead><TableHead>Priority</TableHead><TableHead>Due / Sprint End</TableHead><TableHead>Tags</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className={row.focusBadges.includes("Overdue") ? "border-l-2 border-l-destructive bg-destructive/5" : row.focusBadges.includes("At Risk") ? "border-l-2 border-l-warning bg-warning/5" : undefined}>
              <TableCell className="min-w-[180px]"><FocusBadges badges={row.focusBadges} /></TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">#{row.id}</TableCell>
              <TableCell className="min-w-[300px]"><WorkbenchItemLink row={row} /></TableCell>
              <TableCell><Badge variant="secondary" className="font-normal">{row.type}</Badge></TableCell>
              <TableCell className="max-w-[180px] truncate" title={row.state}>{row.state}</TableCell>
              <TableCell className="max-w-[260px] whitespace-normal">
                {row.parent ? (
                  <a
                    href={row.parent.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="line-clamp-2 font-medium hover:text-primary"
                    title={`#${row.parent.id} ${row.parent.title}`}
                  >
                    #{row.parent.id} {row.parent.title}
                  </a>
                ) : "None"}
              </TableCell>
              <TableCell className="max-w-[240px] whitespace-normal"><span className="line-clamp-2" title={row.sprint ?? undefined}>{row.sprint ?? "Backlog / No Sprint"}</span></TableCell>
              <TableCell className="text-right tabular-nums">{formatHoursCell(row.remainingWork)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHoursCell(row.completedWork)}</TableCell>
              <TableCell>{priorityLabel(row.priority)}</TableCell>
              <TableCell>{formatDateCell(row.dueDate ?? row.sprintEndDate)}</TableCell>
              <TableCell className="max-w-[260px] whitespace-normal">
                <span className="line-clamp-2" title={tagSummary(row)}>{tagSummary(row)}</span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

function AssignedWorkBySprintTable({ rows }: { rows: MyWorkbenchAnalytics["assignedBySprint"] }) {
  return (
    <DashboardTableCard
      title="Assigned Work by Sprint"
      emptyMessage="No assigned sprint workload is available for this scope."
      hasRows={Boolean(rows.length)}
    >
      <Table className="min-w-[900px]">
        <TableHeader><TableRow>
          <TableHead>Sprint</TableHead><TableHead className="text-right">Items</TableHead><TableHead className="text-right">Remaining Work</TableHead>
          <TableHead className="text-right">Completed Work</TableHead><TableHead className="text-right">Unestimated</TableHead><TableHead>Status</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.sprint}>
              <TableCell className="min-w-[280px] font-medium"><span className="line-clamp-2" title={row.sprint}>{row.sprint}</span></TableCell>
              <TableCell className="text-right tabular-nums">{row.items}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHoursCell(row.remainingWork)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatHoursCell(row.completedWork)}</TableCell>
              <TableCell className="text-right tabular-nums">{row.unestimated}</TableCell>
              <TableCell><StatusChip tone={sprintTone(row.status)}>{row.status}</StatusChip></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </DashboardTableCard>
  );
}

function DashboardTableCard({
  title,
  emptyMessage,
  hasRows,
  children,
}: {
  title: string;
  emptyMessage: string;
  hasRows: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="qa-card min-w-0 overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {hasRows ? (
          <div className="max-h-[560px] overflow-auto border-t border-border [&_[data-slot=table-container]]:overflow-visible [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-muted/95 [&_thead]:shadow-[0_1px_0_hsl(var(--border))]">
            {children}
          </div>
        ) : (
          <div className="flex flex-col items-center border-t border-border px-6 py-9 text-center text-sm text-muted-foreground">
            {emptyMessage}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SprintBurnChart({ data }: { data: MyWorkbenchAnalytics["charts"]["sprintBurnStatus"] }) {
  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 4 }}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip content={<WorkbenchChartTooltip suffix="h" />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="idealRemaining" name="Ideal remaining" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="actualRemaining" name="Actual remaining" stroke="hsl(var(--warning))" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, fill: "hsl(var(--card))" }} connectNulls={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type TooltipPayload = {
  name?: string | number;
  value?: string | number;
  color?: string;
  fill?: string;
};

function WorkbenchChartTooltip({
  active,
  payload,
  label,
  suffix = "",
}: {
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string | number;
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      {label ? <div className="mb-1 font-semibold">{String(label)}</div> : null}
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={`${String(item.name)}-${String(item.value)}`} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ backgroundColor: item.color ?? item.fill }} />
            <span className="text-muted-foreground">{item.name}</span>
            <span className="font-semibold text-foreground">{item.value}{suffix}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function WorkbenchItemLink({ row }: { row: WorkbenchFocusItem }) {
  const content = <span className="line-clamp-2">{row.title}</span>;
  return row.url ? (
    <a href={row.url} target="_blank" rel="noreferrer" className="group flex items-start gap-2 rounded-sm font-medium outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">
      {content}<ExternalLink className="mt-0.5 size-3.5 shrink-0 opacity-40 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /><span className="sr-only">(opens in a new tab)</span>
    </a>
  ) : <div className="flex items-start gap-2 font-medium">{content}</div>;
}

function FocusBadges({ badges }: { badges: WorkbenchFocusBadge[] }) {
  if (!badges.length) return <StatusChip tone="neutral">Normal</StatusChip>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {badges.slice(0, 3).map((badge) => <StatusChip key={badge} tone={focusTone(badge)} className="px-2">{badge}</StatusChip>)}
      {badges.length > 3 ? <Badge variant="secondary" className="rounded-full">+{badges.length - 3}</Badge> : null}
    </div>
  );
}

function cardIcon(key: WorkbenchCard["key"]) {
  return {
    openWork: BriefcaseBusiness,
    remainingWork: Clock3,
    missingEstimates: TimerReset,
  }[key] ?? ListChecks;
}

function focusTone(badge: WorkbenchFocusBadge) {
  if (badge === "Overdue") return "error" as const;
  if (badge === "Due Soon" || badge === "High Priority" || badge === "No Estimate" || badge === "At Risk") return "warning" as const;
  if (badge === "Current Sprint") return "info" as const;
  return "neutral" as const;
}

function sprintTone(status: WorkbenchRiskStatus) {
  if (status === "On Track") return "success" as const;
  if (status === "Behind" || status === "At Risk") return "error" as const;
  if (status === "Needs Estimate" || status === "No Estimate") return "warning" as const;
  return "neutral" as const;
}

function sprintModeLabel(value: WorkbenchFilters["sprintMode"]) {
  return {
    current: "Current sprint",
    previous: "Previous sprint",
    next: "Next sprint",
    all_active: "All active sprints",
    custom: "Custom sprint",
    overall: "Overall / All assigned work",
  }[value];
}

function priorityLabel(value: number | null) {
  return value === null ? "No priority" : `Priority ${value}`;
}

function formatHoursCell(value: number | null) {
  return value === null ? "No estimate" : `${Math.round(value * 10) / 10}h`;
}

function formatDateCell(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function shortDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function tagSummary(row: WorkbenchFocusItem) {
  return row.tags.length ? row.tags.join(", ") : "No tags";
}

function chartSummary(data: Array<{ name: string; value: number }>) {
  return data.map((item) => `${item.name}: ${item.value}`).join(". ");
}
