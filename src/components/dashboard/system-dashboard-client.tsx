"use client";

import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  ShieldAlert,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

type SystemTab =
  | "overview"
  | "savings"
  | "requirements"
  | "coverage"
  | "knowledge"
  | "ado"
  | "adoption";

export function SystemDashboardsClient({ active }: { active: boolean }) {
  const scope = useActiveProject();
  const previousProjectId = useRef<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(initialFilters);
  const [data, setData] = useState<SystemDashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SystemTab>("overview");

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
    setActiveTab("overview");
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
                <TabsTrigger value="overview" className="h-8 px-4">Executive Overview</TabsTrigger>
                <TabsTrigger value="savings" className="h-8 px-4">Time Savings</TabsTrigger>
                <TabsTrigger value="requirements" className="h-8 px-4">Requirement Quality</TabsTrigger>
                <TabsTrigger value="coverage" className="h-8 px-4">Test Design & Coverage</TabsTrigger>
                <TabsTrigger value="knowledge" className="h-8 px-4">Knowledge Hub</TabsTrigger>
                <TabsTrigger value="ado" className="h-8 px-4">ADO Automation</TabsTrigger>
                <TabsTrigger value="adoption" className="h-8 px-4">Adoption & Feedback</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="space-y-4">
              <OverviewSection data={data} />
            </TabsContent>
            <TabsContent value="savings" className="space-y-4">
              <SavingsSection data={data} />
            </TabsContent>
            <TabsContent value="requirements" className="space-y-4">
              <RequirementSection data={data} />
            </TabsContent>
            <TabsContent value="coverage" className="space-y-4">
              <CoverageSection data={data} />
            </TabsContent>
            <TabsContent value="knowledge" className="space-y-4">
              <KnowledgeSection data={data} />
            </TabsContent>
            <TabsContent value="ado" className="space-y-4">
              <AdoSection data={data} />
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
        <Select
          value={filters.datePreset}
          onValueChange={(datePreset) => setFilters((current) => ({ ...current, datePreset: datePreset as SystemDashboardDatePreset }))}
          disabled={disabled}
        >
          <SelectTrigger aria-label="System dashboard date range"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="14d">Last 14 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="custom">Custom range</SelectItem>
          </SelectContent>
        </Select>
        <SearchableMultiSelect
          options={data?.filterMetadata.workflows ?? workflowTypeValues.map((value) => ({ value, label: workflowLabels[value] }))}
          value={filters.workflowTypes}
          onValueChange={(workflowTypes) => setFilters((current) => ({ ...current, workflowTypes: workflowTypes as WorkflowType[] }))}
          getOptionValue={(option) => option.value}
          getOptionLabel={(option) => option.label}
          placeholder="All workflows"
          ariaLabel="Workflow types"
          disabled={disabled}
        />
        <Select
          value={filters.userId ?? "__all__"}
          onValueChange={(userId) => setFilters((current) => ({ ...current, userId: userId === "__all__" ? null : userId }))}
          disabled={disabled || !data?.filterMetadata.users.length}
        >
          <SelectTrigger aria-label="System dashboard user"><SelectValue placeholder="All users" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All users</SelectItem>
            {data?.filterMetadata.users.map((user) => <SelectItem key={user.value} value={user.value}>{user.label}</SelectItem>)}
          </SelectContent>
        </Select>
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

function OverviewSection({ data }: { data: SystemDashboardAnalytics }) {
  const overview = data.overview;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <ValueMetric title="Estimated Hours Saved" metric={overview.estimatedHoursSaved} icon={Clock3} />
        <ValueMetric title="AI Workflows Completed" metric={overview.workflowsCompleted} icon={Sparkles} />
        <ValueMetric title="High-Risk Issues Found Early" metric={overview.highRiskIssuesFound} icon={ShieldAlert} tone="red" />
        <ValueMetric title="Test Cases Published" metric={overview.testCasesPublished} icon={TestTube2} tone="green" />
        <ValueMetric title="AI Acceptance Rate" metric={overview.acceptanceRate} icon={CheckCircle2} formatter={(value) => `${value}%`} />
        <MetricCard
          title="Most Valuable Workflow"
          value={overview.mostValuableWorkflow ?? "Needs data"}
          description={`${overview.manualActionsAvoided} manual Azure DevOps actions avoided in this scope.`}
          icon={Workflow}
          tone="purple"
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Estimated Saved Hours by Workflow" empty={!hasSavingsData(data)}>
          <SavedHoursBar rows={data.workflowSavings.rows} />
        </ChartCard>
        <ChartCard title="Estimated Saved Hours Trend" empty={!hasSavingsData(data)}>
          <SavedHoursTrend rows={data.workflowSavings.trend} />
        </ChartCard>
      </div>
    </>
  );
}

function SavingsSection({ data }: { data: SystemDashboardAnalytics }) {
  return (
    <>
      <div className="grid gap-4 xl:grid-cols-2">
        <ChartCard title="Estimated Saved Hours by Workflow" empty={!hasSavingsData(data)}>
          <SavedHoursBar rows={data.workflowSavings.rows} />
        </ChartCard>
        <ChartCard title="Estimated Saved Hours Trend" empty={!hasSavingsData(data)}>
          <SavedHoursTrend rows={data.workflowSavings.trend} />
        </ChartCard>
      </div>
      <Card className="qa-card">
        <CardHeader><CardTitle className="text-base">Workflow Time Savings</CardTitle></CardHeader>
        <CardContent className="space-y-3 overflow-x-auto">
          <p className="text-xs text-muted-foreground">
            Actual time is available after generation completes. Estimated savings are counted only after output is accepted, published, or rated useful.
          </p>
          <Table>
            <TableHeader><TableRow>
              <TableHead>Workflow</TableHead><TableHead>Runs</TableHead><TableHead>Manual Baseline</TableHead>
              <TableHead>Actual Avg</TableHead><TableHead>Avg Saved</TableHead><TableHead>Total Saved</TableHead>
              <TableHead>Acceptance</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {data.workflowSavings.rows.map((row) => (
                <TableRow key={row.workflowType}>
                  <TableCell className="font-medium">{row.workflow}</TableCell>
                  <TableCell>{row.runs}</TableCell>
                  <TableCell>{minutes(row.manualBaselineMinutes)}</TableCell>
                  <TableCell>{row.actualAverageMinutes === null ? "Needs data" : minutes(row.actualAverageMinutes)}</TableCell>
                  <TableCell>{minutes(row.averageSavedMinutes)}</TableCell>
                  <TableCell>{hours(row.totalSavedMinutes)}</TableCell>
                  <TableCell>{row.acceptanceRate === null ? "Needs data" : `${row.acceptanceRate}%`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function RequirementSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.requirementQuality;
  return (
    <>
      <MetricGrid items={[
        ["Requirements Analyzed", value.requirementsAnalyzed, "Completed analysis runs.", Activity],
        ["Average Testability Score", value.averageTestabilityScore, "Average recorded score out of 100.", Gauge],
        ["Requirements with Critical/High Gaps", value.requirementsWithCriticalHighGaps, "Requirements with at least one high-risk finding.", ShieldAlert],
        ["Total Gaps Found", value.totalGapsFound, "Generated requirement findings.", Sparkles],
        ["Average Risks per Requirement", value.averageRisksPerRequirement, "Average findings generated per analyzed requirement.", Workflow],
        ["Most Common Issue Category", value.mostCommonIssueCategory, "Most frequent normalized checklist category.", Zap],
      ]} />
      <DistributionCard title="Requirement Issue Categories" rows={value.issueCategories} emptyMessage="No normalized requirement findings are available yet." />
    </>
  );
}

function CoverageSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.testDesignCoverage;
  return (
    <>
      <MetricGrid items={[
        ["Test Cases Generated", value.testCasesGenerated, "Generated test design outputs.", Sparkles],
        ["Test Cases Published", value.testCasesPublished, "Successfully published cases.", TestTube2],
        ["Average Cases per Story", value.averageTestCasesPerStory, "Generated cases divided by unique stories.", Gauge],
        ["Generated Cases Accepted", value.accepted, "Published or explicitly selected cases.", CheckCircle2],
        ["Generated Cases Edited", value.edited, "Cases changed during review.", Activity],
        ["Generated Cases Rejected", value.rejected, "Generated cases not accepted.", ShieldAlert],
        ["Estimated Design Hours Saved", value.estimatedHoursSaved, "Estimated realized savings for design and gap analysis.", Clock3],
        ["Stories Reviewed for Coverage", value.storiesReviewedForCoverage, "Test Gap Analysis runs.", Workflow],
        ["Average Coverage Score", value.averageCoverageScore, "Recorded coverage score out of 100.", Gauge],
        ["Missing Coverage Areas Found", value.missingCoverageAreas, "Uncovered traceability areas.", ShieldAlert],
        ["Weak or Duplicate Cases", value.weakDuplicateCases, "Coverage findings classified as weak or duplicate.", Activity],
      ]} />
      <DistributionCard title="Coverage Category Distribution" rows={value.coverageCategories} emptyMessage="Coverage categories will appear after test design workflows are recorded." />
    </>
  );
}

function KnowledgeSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.knowledgeHub;
  return (
    <>
      <MetricGrid items={[
        ["Indexed Work Items", value.indexedWorkItems, "Active work items in local project context.", Database],
        ["Knowledge Items", value.knowledgeItems, "Saved compiled knowledge entries.", Sparkles],
        ["Last Knowledge Refresh", value.lastRefresh ? new Date(value.lastRefresh).toLocaleString() : null, "Latest indexed work-item update.", RefreshCw],
        ["Failed Indexing Runs", value.failedIndexingRuns, "Failed normalized knowledge indexing runs.", ShieldAlert],
        ["AI Runs Using Context", value.aiRunsUsingContext, "AI runs with recorded project context.", Bot],
        ["Context Usage Rate", value.contextUsageRate === null ? null : `${value.contextUsageRate}%`, "AI runs using context divided by AI runs.", Gauge],
        ["Stale Knowledge Warnings", value.staleKnowledgeWarnings, "Open knowledge lint warnings.", Activity],
      ]} />
      <DistributionCard title="Most Referenced Context Items" rows={value.mostReferencedContextItems} emptyMessage="Context references will appear after instrumented AI workflows use project knowledge." />
    </>
  );
}

function AdoSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.adoAutomation;
  return <MetricGrid items={[
    ["Comments Published", value.commentsPublished, "Requirement comments pushed to Azure DevOps.", CheckCircle2],
    ["Test Cases Created", value.testCasesCreated, "Azure Test Case work items created.", TestTube2],
    ["Work Items Linked", value.workItemsLinked, "Test cases linked automatically to stories.", Workflow],
    ["Suite Migrations Completed", value.suiteMigrationsCompleted, "Successful suite migration operations.", Activity],
    ["Bulk Tasks Created", value.bulkTasksCreated, "Child tasks created by bulk automation.", Zap],
    ["Manual ADO Actions Avoided", value.manualActionsAvoided, "Concrete successful Azure DevOps actions automated.", Clock3],
    ["ADO Publish Success Rate", value.publishSuccessRate === null ? null : `${value.publishSuccessRate}%`, "Fully successful ADO operations (partial successes are excluded).", Gauge],
    ["Failed ADO Operations", value.failedOperations, "ADO operations where every sub-operation failed.", ShieldAlert],
  ]} />;
}

function AdoptionSection({ data }: { data: SystemDashboardAnalytics }) {
  const value = data.adoptionFeedback;
  return <MetricGrid items={[
    ["Active Users", value.activeUsers, "Distinct recorded workflow users.", Activity],
    ["Runs per User", value.runsPerUser, "Workflow runs divided by active users.", Workflow],
    ["Most Used Feature", value.mostUsedFeature, "Workflow with the most recorded runs.", Zap],
    ["Average Feedback Rating", value.averageFeedbackRating, "1 Not useful, 2 Partially useful, 3 Useful.", Sparkles],
    ["Useful Output Rate", value.usefulOutputRate === null ? null : `${value.usefulOutputRate}%`, "Useful or partially useful ratings.", CheckCircle2],
    ["Rejection Rate", value.rejectionRate === null ? null : `${value.rejectionRate}%`, "Rejected outputs divided by generated outputs.", ShieldAlert],
    ["Top Workflow by Adoption", value.topWorkflowByAdoption, "Workflow with the greatest recorded adoption.", Gauge],
    ["Feedback Responses", value.feedbackCount, "Optional feedback responses collected.", Bot],
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

function DistributionCard({ title, rows, emptyMessage }: { title: string; rows: Array<{ name: string; value: number }>; emptyMessage: string }) {
  return (
    <Card className="qa-card">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        {rows.length ? (
          <div className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows.slice(0, 12)} layout="vertical" margin={{ left: 80, right: 20 }}>
                <CartesianGrid stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" allowDecimals={false} />
                <YAxis type="category" dataKey="name" width={160} tick={{ fontSize: 10 }} />
                <Tooltip
                  content={<SystemChartTooltip />}
                  cursor={{ fill: "hsl(var(--muted) / 0.35)" }}
                />
                <Bar dataKey="value" fill="hsl(var(--chart-2))" radius={[2, 6, 6, 2]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        )}
      </CardContent>
    </Card>
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
