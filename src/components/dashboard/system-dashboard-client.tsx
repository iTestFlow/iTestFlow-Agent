"use client";

import {
  Activity,
  Clock3,
  RefreshCw,
  Sparkles,
  TestTube2,
  Workflow,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { MetricCard } from "@/components/qa/metric-card";
import { EmptyState } from "@/components/qa/empty-state";
import { ErrorState } from "@/components/qa/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { workflowLabels, workflowTypeValues, type WorkflowType } from "@/modules/analytics/analytics-config";
import { AutoRefreshStatus } from "@/components/dashboard/auto-refresh-status";
import { useActiveProject } from "@/shared/lib/use-active-project";
import { useDashboardRefresh } from "@/shared/lib/use-dashboard-refresh";
import type {
  SystemDashboardAnalytics,
  SystemDashboardDatePreset,
} from "@/types/system-dashboard";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const STALE_THRESHOLD_MS = 2 * 60_000;
const FILTER_SETTLE_MS = 1_500;

type FilterState = {
  datePreset: SystemDashboardDatePreset;
  from: string;
  to: string;
  workflowTypes: WorkflowType[];
  userId: string | null;
};

const initialFilters: FilterState = {
  datePreset: "30d",
  from: "",
  to: "",
  workflowTypes: [],
  userId: null,
};

const SYSTEM_DATE_PRESET_OPTIONS = [
  { value: "7d", label: "Last 7 days" },
  { value: "14d", label: "Last 14 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "overall", label: "All time" },
  { value: "custom", label: "Custom range" },
];

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50";

type SystemTab = "value" | "adoption";

export function SystemDashboardsClient({ active }: { active: boolean }) {
  const scope = useActiveProject();
  const previousProjectId = useRef<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [data, setData] = useState<SystemDashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SystemTab>("value");

  const requestBody = useMemo(() => ({
    scope,
    filters: {
      datePreset: filters.datePreset,
      from: filters.datePreset === "custom" ? filters.from || undefined : undefined,
      to: filters.datePreset === "custom" ? filters.to || undefined : undefined,
      workflowTypes: filters.workflowTypes.length ? filters.workflowTypes : undefined,
      userId: filters.userId,
    },
  }), [filters, scope]);
  const filtersReady = filters.datePreset !== "custom" || Boolean(filters.from && filters.to);

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
    enabled: active && filtersReady && Boolean(scope) && Boolean(data),
    loading,
    intervalMs: REFRESH_INTERVAL_MS,
    staleMs: STALE_THRESHOLD_MS,
    filterSettleMs: FILTER_SETTLE_MS,
  });

  useEffect(() => {
    const projectId = scope?.azureProjectId ?? null;
    if (projectId === previousProjectId.current) return;
    previousProjectId.current = projectId;
    setFilters(initialFilters);
    setData(null);
    setLoading(Boolean(scope));
    setError(null);
    setRefreshFailed(false);
    setActiveTab("value");
  }, [scope, setRefreshFailed]);

  useEffect(() => {
    if (!active || scope === undefined || !scope) return;
    if (!filtersReady) return;
    const controller = new AbortController();
    void (async () => {
      const background = beginFetch();
      if (!background) {
        setLoading(true);
        setError(null);
      }
      try {
        const response = await fetch("/api/dashboard/system-analytics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          cache: "no-store",
          signal: controller.signal,
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "System dashboard refresh failed.");
        setData(json as SystemDashboardAnalytics);
        setError(null);
        setRefreshFailed(false);
      } catch (fetchError) {
        if (controller.signal.aborted) return;
        if (background) {
          setRefreshFailed(true);
        } else {
          setError(fetchError instanceof Error ? fetchError.message : "System dashboard refresh failed.");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          settleFetch();
        }
      }
    })();
    return () => controller.abort();
  }, [active, filtersReady, requestBody, refreshToken, scope, beginFetch, settleFetch, setRefreshFailed]);

  const handleFiltersChange: React.Dispatch<React.SetStateAction<FilterState>> = (next) => {
    setFilters(next);
    markInteracting();
  };

  if (scope === undefined) return <SystemDashboardSkeleton />;
  if (!scope) {
    return (
      <EmptyState
        title="Select an Azure DevOps project"
        description="Use the project selector to load stakeholder value metrics for that iTestFlow project."
      />
    );
  }

  return (
    <div className="space-y-4">
      <SystemFilters filters={filters} setFilters={handleFiltersChange} data={data} disabled={loading && !data} />
      <RefreshBar
        projectName={scope.azureProjectName}
        generatedAt={data?.generatedAt}
        nextRefreshAt={nextRefreshAt}
        refreshing={fetching}
        loading={loading}
        refreshFailed={refreshFailed}
        onRefresh={() => triggerRefresh(false)}
      />
      {error ? <ErrorState title="System dashboard refresh failed" message={error} onRetry={() => triggerRefresh(false)} /> : null}
      {!data && loading ? <SystemDashboardSkeleton /> : null}
      {data ? (
        <>
          {data.warnings.length ? (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
              {data.warnings[0]}
            </div>
          ) : null}
          <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as SystemTab)} className="flex-col gap-4">
            <div className="max-w-full overflow-x-auto pb-1">
              <TabsList variant="primary" className="h-10 min-w-max justify-start">
                <TabsTrigger value="value" className="h-8 px-4">Value</TabsTrigger>
                <TabsTrigger value="adoption" className="h-8 px-4">Adoption</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="value" className="space-y-4">
              <ValueSection data={data} />
            </TabsContent>
            <TabsContent value="adoption" className="space-y-4">
              <AdoptionSection data={data} />
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

function SystemFilters({
  filters,
  setFilters,
  data,
  disabled,
}: {
  filters: FilterState;
  setFilters: React.Dispatch<React.SetStateAction<FilterState>>;
  data: SystemDashboardAnalytics | null;
  disabled: boolean;
}) {
  return (
    <section className="qa-card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <select
          className={selectClass}
          value={filters.datePreset}
          onChange={(event) => setFilters((current) => ({ ...current, datePreset: event.target.value as SystemDashboardDatePreset }))}
          disabled={disabled}
          aria-label="System dashboard date range"
        >
          {SYSTEM_DATE_PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <SearchableMultiSelect
          options={data?.filterMetadata.workflows ?? workflowTypeValues.map((value) => ({ value, label: workflowLabels[value] }))}
          value={filters.workflowTypes}
          onValueChange={(workflowTypes) => setFilters((current) => ({ ...current, workflowTypes: workflowTypes as WorkflowType[] }))}
          getOptionValue={(option) => option.value}
          getOptionLabel={(option) => option.label}
          placeholder="All workflows"
          ariaLabel="Workflow types"
          triggerClassName="h-10"
          disabled={disabled}
        />
        <select
          className={selectClass}
          value={filters.userId ?? "__all__"}
          onChange={(event) => setFilters((current) => ({ ...current, userId: event.target.value === "__all__" ? null : event.target.value }))}
          disabled={disabled || !data?.filterMetadata.users.length}
          aria-label="System dashboard user"
        >
          <option value="__all__">All users</option>
          {data?.filterMetadata.users.map((user) => <option key={user.value} value={user.value}>{user.label}</option>)}
        </select>
      </div>
      {filters.datePreset === "custom" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} className="w-[170px]" />
          <span className="text-xs text-muted-foreground">to</span>
          <Input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} className="w-[170px]" />
        </div>
      ) : null}
    </section>
  );
}

function RefreshBar({
  projectName,
  generatedAt,
  nextRefreshAt,
  refreshing,
  loading,
  refreshFailed,
  onRefresh,
}: {
  projectName: string;
  generatedAt?: string;
  nextRefreshAt: number | null;
  refreshing: boolean;
  loading: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">iTestFlow Value Scope</div>
          <div className="mt-0.5 text-sm font-semibold">{projectName}</div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <AutoRefreshStatus
            generatedAt={generatedAt}
            nextRefreshAt={nextRefreshAt}
            refreshing={refreshing}
            failed={refreshFailed}
          />
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}

function ValueSection({ data }: { data: SystemDashboardAnalytics }) {
  const overview = data.overview;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ValueMetric title="Estimated Hours Saved" metric={overview.estimatedHoursSaved} icon={Clock3} />
        <ValueMetric title="AI Workflows Completed" metric={overview.workflowsCompleted} icon={Sparkles} />
        <ValueMetric title="Test Cases Published" metric={overview.testCasesPublished} icon={TestTube2} tone="green" />
        <MetricCard
          title="Manual ADO Actions Automated"
          value={String(overview.manualActionsAvoided)}
          description="Concrete successful Azure DevOps actions automated in this scope."
          icon={Workflow}
          tone="purple"
        />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Estimated Hours Saved compares each workflow&apos;s actual run time against a fixed manual-effort baseline, counted only after the output is accepted or published. Treat it as a directional estimate; the other tiles are exact counts.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Estimated Saved Hours by Workflow" empty={!hasSavingsData(data)}>
          <SavedHoursBar rows={data.workflowSavings.rows} />
        </ChartCard>
        <WorkflowSavingsTable rows={data.workflowSavings.rows} />
      </div>
      <ChartCard title="Estimated Saved Hours Trend" empty={!hasSavingsData(data)}>
        <SavedHoursTrend rows={data.workflowSavings.trend} />
      </ChartCard>
    </>
  );
}

function WorkflowSavingsTable({ rows }: { rows: SystemDashboardAnalytics["workflowSavings"]["rows"] }) {
  const activeRows = rows.filter((row) => row.runs > 0);
  return (
    <Card className="qa-card">
      <CardHeader><CardTitle className="text-base">Workflow Time Savings</CardTitle></CardHeader>
      <CardContent className="space-y-3 overflow-x-auto">
        <p className="text-xs text-muted-foreground">
          Manual baselines use fixed workflow defaults. Estimated savings are counted only after a workflow&apos;s output is accepted or published.
        </p>
        {activeRows.length ? (
          <Table className="w-full table-fixed">
            <colgroup>
              <col className="w-[34%]" />
              <col className="w-[12%]" />
              <col className="w-[19%]" />
              <col className="w-[18%]" />
              <col className="w-[17%]" />
            </colgroup>
            <TableHeader><TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Manual baseline</TableHead>
              <TableHead className="text-right">Avg actual</TableHead>
              <TableHead className="text-right">Total saved</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {activeRows.map((row) => (
                <TableRow key={row.workflowType}>
                  <TableCell className="truncate font-medium" title={row.workflow}>{row.workflow}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.runs}</TableCell>
                  <TableCell className="text-right tabular-nums">{minutes(row.manualBaselineMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.actualAverageMinutes === null ? "Needs data" : minutes(row.actualAverageMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{hours(row.totalSavedMinutes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">No workflow runs are recorded for this scope yet.</div>
        )}
      </CardContent>
    </Card>
  );
}

function AdoptionSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.adoption;
  return <MetricGrid items={[
    ["Active Users", value.activeUsers, "Distinct recorded workflow users.", Activity],
    ["Workflow Runs", value.workflowRuns, "Recorded workflow runs in the selected period.", Sparkles],
    ["Most Used Feature", value.mostUsedFeature, "Workflow with the most recorded runs.", Zap],
  ]} />;
}

function ValueMetric({
  title,
  metric,
  icon,
  formatter,
  tone = "blue",
}: {
  title: string;
  metric: { value: number | null; available: boolean; supportingText: string };
  icon: typeof Clock3;
  formatter?: (value: number) => string;
  tone?: "blue" | "green" | "yellow" | "red" | "purple" | "neutral";
}) {
  const value = metric.available && metric.value !== null
    ? formatter?.(metric.value) ?? String(metric.value)
    : "Needs data";
  return <MetricCard title={title} value={value} description={metric.supportingText} icon={icon} tone={tone} />;
}

function MetricGrid({
  items,
}: {
  items: Array<[string, string | number | null, string, typeof Activity]>;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(([title, value, description, icon]) => (
        <MetricCard
          key={title}
          title={title}
          value={value === null ? "Needs data" : String(value)}
          description={description}
          icon={icon}
          tone={value === null ? "neutral" : "blue"}
        />
      ))}
    </div>
  );
}

function ChartCard({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }) {
  return (
    <Card className="qa-card">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {empty ? <div className="flex h-[280px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">No value data is available yet.</div> : children}
      </CardContent>
    </Card>
  );
}

function SavedHoursBar({ rows }: { rows: SystemDashboardAnalytics["workflowSavings"]["rows"] }) {
  const values = rows
    .filter((row) => row.totalSavedMinutes > 0)
    .map((row) => ({
      name: row.workflow,
      realizedHours: round(row.totalSavedMinutes / 60),
    }));
  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={values} layout="vertical" margin={{ left: 80, right: 20 }}>
          <CartesianGrid stroke="hsl(var(--border))" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10 }} />
          <Tooltip
            content={<SystemChartTooltip suffix=" hr" />}
            cursor={{ fill: "hsl(var(--muted) / 0.35)" }}
          />
          <Legend />
          <Bar dataKey="realizedHours" name="Realized estimated hours" fill="hsl(var(--chart-1))" radius={[2, 6, 6, 2]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SavedHoursTrend({ rows }: { rows: SystemDashboardAnalytics["workflowSavings"]["trend"] }) {
  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip content={<SystemChartTooltip suffix=" hr" />} />
          <Legend />
          <Line type="monotone" dataKey="savedHours" name="Realized estimated hours" stroke="hsl(var(--chart-1))" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SystemDashboardSkeleton() {
  return <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}</div>;
}

type SystemChartTooltipPayload = {
  name?: string | number;
  value?: string | number;
  color?: string;
  fill?: string;
};

function SystemChartTooltip({
  active,
  payload,
  label,
  suffix = "",
}: {
  active?: boolean;
  payload?: SystemChartTooltipPayload[];
  label?: string | number;
  suffix?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-xs rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
      {label !== undefined && label !== null ? (
        <div className="mb-1 font-semibold text-foreground">{String(label)}</div>
      ) : null}
      <div className="space-y-1">
        {payload.map((item) => (
          <div key={`${String(item.name)}-${String(item.value)}`} className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: item.color ?? item.fill }}
            />
            <span className="text-muted-foreground">{item.name}</span>
            <span className="ml-auto font-semibold text-foreground">
              {item.value}{suffix}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function minutes(value: number) {
  return `${round(value)} min`;
}

function hours(value: number) {
  return `${round(value / 60)} hr`;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function hasSavingsData(data: SystemDashboardAnalytics) {
  return data.workflowSavings.rows.some((row) => row.totalSavedMinutes > 0);
}
