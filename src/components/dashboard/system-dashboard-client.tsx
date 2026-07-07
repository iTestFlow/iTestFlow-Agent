"use client";

import {
  Activity,
  AlertTriangle,
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

import { DashboardEmptyPanel, DashboardLoadingState } from "@/components/dashboard/dashboard-states";
import { MetricCard } from "@/components/qa/metric-card";
import { EmptyState } from "@/components/qa/empty-state";
import { ErrorState } from "@/components/qa/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SearchableMultiSelect } from "@/components/ui/searchable-multi-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { workflowLabels, workflowTypeValues, type WorkflowType } from "@/modules/analytics/analytics-config";
import { AutoRefreshStatus } from "@/components/dashboard/auto-refresh-status";
import { useActiveProject } from "@/shared/lib/use-active-project";
import { apiErrorMessage, caughtErrorMessage } from "@/shared/lib/api-error-message";
import { useDashboardRefresh } from "@/shared/lib/use-dashboard-refresh";
import type {
  SystemDashboardAnalytics,
  SystemDashboardDatePreset,
} from "@/types/system-dashboard";
import { adoptionActivityMetric } from "@/components/dashboard/system-dashboard-adoption-metrics";

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
        if (!response.ok) throw new Error(apiErrorMessage(json, "System dashboard refresh failed."));
        setData(json as SystemDashboardAnalytics);
        setError(null);
        setRefreshFailed(false);
      } catch (fetchError) {
        if (controller.signal.aborted) return;
        if (background) {
          setRefreshFailed(true);
        } else {
          setError(caughtErrorMessage(fetchError, "System dashboard refresh failed."));
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
    <div className="content-stack" aria-busy={loading}>
      <SystemFilters filters={filters} setFilters={handleFiltersChange} data={data} disabled={loading && !data} />
      <RefreshBar
        projectName={scope.azureProjectName}
        scopeLabel={data?.effectiveScope.label}
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
            <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="leading-5">{data.warnings[0]}</span>
            </div>
          ) : null}
          <Tabs id="system-dashboard-details" value={activeTab} onValueChange={(value) => setActiveTab(value as SystemTab)} className="flex-col gap-4">
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
  const canViewWorkspaceUsers = data?.permissions.canViewWorkspaceUsers ?? true;
  const userOptions = data?.filterMetadata.users ?? [];

  return (
    <section className="qa-card space-y-3 p-4">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="system-dashboard-date-range">Date range</Label>
          <NativeSelect
            id="system-dashboard-date-range"
            className="h-10"
            value={filters.datePreset}
            onChange={(event) => setFilters((current) => ({ ...current, datePreset: event.target.value as SystemDashboardDatePreset }))}
            disabled={disabled}
          >
            {SYSTEM_DATE_PRESET_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </NativeSelect>
        </div>
        <div className="space-y-1.5">
          <Label>Workflow types</Label>
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
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="system-dashboard-user">User</Label>
          {canViewWorkspaceUsers ? (
            <NativeSelect
              id="system-dashboard-user"
              className="h-10"
              value={filters.userId ?? "__all__"}
              onChange={(event) => setFilters((current) => ({ ...current, userId: event.target.value === "__all__" ? null : event.target.value }))}
              disabled={disabled || !userOptions.length}
            >
              <option value="__all__">All users</option>
              {userOptions.map((user) => <option key={user.value} value={user.value}>{user.label}</option>)}
            </NativeSelect>
          ) : (
            <NativeSelect id="system-dashboard-user" className="h-10" value="__mine__" disabled>
              <option value="__mine__">My activity only</option>
            </NativeSelect>
          )}
        </div>
      </div>
      {!canViewWorkspaceUsers ? (
        <p className="text-xs leading-5 text-muted-foreground">
          Members can only view their own workflow analytics. Owners and admins can view all workspace users.
        </p>
      ) : null}
      {filters.datePreset === "custom" ? (
        <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="system-dashboard-start-date">Start date</Label>
            <Input id="system-dashboard-start-date" type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} className="w-full sm:w-[180px]" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="system-dashboard-end-date">End date</Label>
            <Input id="system-dashboard-end-date" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} className="w-full sm:w-[180px]" />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function RefreshBar({
  projectName,
  scopeLabel,
  generatedAt,
  nextRefreshAt,
  refreshing,
  loading,
  refreshFailed,
  onRefresh,
}: {
  projectName: string;
  scopeLabel?: string;
  generatedAt?: string;
  nextRefreshAt: number | null;
  refreshing: boolean;
  loading: boolean;
  refreshFailed: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="content-surface px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-xs font-medium uppercase text-muted-foreground">iTestFlow Value Scope</div>
          <div className="mt-0.5 text-sm font-semibold">{scopeLabel ? `${projectName} · ${scopeLabel}` : projectName}</div>
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <ValueMetric title="Net Hours Saved (after review)" metric={overview.laborHoursSaved} icon={Clock3} />
        <ValueMetric title="Cycle-time Hours Saved" metric={overview.cycleHoursSaved} icon={Clock3} tone="neutral" />
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
        <strong>Net Hours Saved</strong> is the human time freed up: each workflow&apos;s fixed manual-effort baseline minus the estimated effort to review the AI output, counted only after the output is accepted or published. <strong>Cycle-time Hours Saved</strong> also subtracts the model&apos;s generation time, reflecting end-to-end turnaround. Both are directional estimates; the other tiles are exact counts.
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Saved Hours by Workflow" empty={!hasSavingsData(data)}>
          <SavedHoursBar rows={data.workflowSavings.rows} />
        </ChartCard>
        <WorkflowSavingsTable rows={data.workflowSavings.rows} />
      </div>
      <ChartCard title="Saved Hours Trend" empty={!hasSavingsData(data)}>
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
          Manual = fully-manual baseline; Review = estimated effort to review the AI output; LLM = model generation time. Net saved (= manual − review) and cycle saved (= manual − LLM − review) are counted only after a workflow&apos;s output is accepted or published.
        </p>
        {activeRows.length ? (
          <Table className="w-full min-w-[44rem]">
            <TableHeader><TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead className="text-right">Runs</TableHead>
              <TableHead className="text-right">Manual</TableHead>
              <TableHead className="text-right">Review</TableHead>
              <TableHead className="text-right">LLM</TableHead>
              <TableHead className="text-right">Net saved</TableHead>
              <TableHead className="text-right">Cycle saved</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {activeRows.map((row) => (
                <TableRow key={row.workflowType}>
                  <TableCell className="font-medium" title={row.workflow}>
                    {row.workflow}
                    {row.reviewExceedsManual ? (
                      <span className="ml-2 inline-flex text-warning" title="Review effort meets or exceeds the manual baseline; the AI is not saving time here.">
                        <AlertTriangle className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">Review effort exceeds the manual baseline</span>
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{row.runs}</TableCell>
                  <TableCell className="text-right tabular-nums">{minutes(row.manualBaselineMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{minutes(row.reviewMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.llmMinutes === null ? "—" : minutes(row.llmMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{hours(row.laborSavedMinutes)}</TableCell>
                  <TableCell className="text-right tabular-nums">{hours(row.cycleSavedMinutes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <DashboardEmptyPanel title="No workflow runs yet" message="No workflow runs are recorded for this scope. Try a wider date range or clear the workflow filter." compact />
        )}
      </CardContent>
    </Card>
  );
}

function AdoptionSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.adoption;
  return <MetricGrid items={[
    adoptionActivityMetric(data),
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
        {empty ? <DashboardEmptyPanel message="No value data is available for this scope yet. Try a wider date range or clear the active filters." /> : children}
      </CardContent>
    </Card>
  );
}

function SavedHoursBar({ rows }: { rows: SystemDashboardAnalytics["workflowSavings"]["rows"] }) {
  const values = rows
    .filter((row) => row.laborSavedMinutes > 0 || row.cycleSavedMinutes > 0)
    .map((row) => ({
      name: row.workflow,
      laborHours: round(row.laborSavedMinutes / 60),
      cycleHours: round(row.cycleSavedMinutes / 60),
    }));
  return (
    <div className="h-[260px] sm:h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={values} layout="vertical" margin={{ left: 8, right: 8 }}>
          <CartesianGrid stroke="hsl(var(--border))" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 11 }} />
          <YAxis type="category" dataKey="name" width={132} tick={{ fontSize: 11 }} tickFormatter={(value: string) => value.length > 22 ? `${value.slice(0, 21)}…` : value} />
          <Tooltip
            content={<SystemChartTooltip suffix=" hr" />}
            cursor={{ fill: "hsl(var(--muted) / 0.35)" }}
          />
          <Legend />
          <Bar dataKey="laborHours" name="Net hours (after review)" fill="hsl(var(--chart-1))" radius={[2, 6, 6, 2]} />
          <Bar dataKey="cycleHours" name="Cycle-time hours" fill="hsl(var(--chart-2))" radius={[2, 6, 6, 2]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function SavedHoursTrend({ rows }: { rows: SystemDashboardAnalytics["workflowSavings"]["trend"] }) {
  return (
    <div className="h-[260px] sm:h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows}>
          <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip content={<SystemChartTooltip suffix=" hr" />} />
          <Legend />
          <Line type="monotone" dataKey="savedHours" name="Net hours (after review)" stroke="hsl(var(--chart-1))" strokeWidth={2} />
          <Line type="monotone" dataKey="cycleHours" name="Cycle-time hours" stroke="hsl(var(--chart-2))" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function SystemDashboardSkeleton() {
  return <DashboardLoadingState label="Loading platform insights" cards={5} />;
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
  return data.workflowSavings.rows.some((row) => row.laborSavedMinutes > 0 || row.cycleSavedMinutes > 0);
}
