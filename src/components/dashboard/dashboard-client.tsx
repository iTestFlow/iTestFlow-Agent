"use client";

import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DashboardFilters, defaultDashboardFilters, type DashboardFilterState } from "@/components/dashboard/dashboard-filters";
import { ActionRequiredPanel, DashboardKpiGrid, ReleaseReadinessCard } from "@/components/dashboard/dashboard-summary";
import { AgingBugsTable, BlockersTable, CoverageMatrixTable, ReleaseBlockersTable, TestingProgressTable } from "@/components/dashboard/dashboard-tables";
import {
  CoverageBarChart,
  DashboardChartCard,
  DistributionBarChart,
  DonutChart,
  ExecutionStackedBarChart,
  TrendLineChart,
} from "@/components/dashboard/dashboard-visualizations";
import { EmptyState } from "@/components/qa/empty-state";
import { ErrorState } from "@/components/qa/error-state";
import { LoadingState } from "@/components/qa/loading-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AutoRefreshStatus } from "@/components/dashboard/auto-refresh-status";
import { useActiveProject } from "@/shared/lib/use-active-project";
import { useDashboardRefresh } from "@/shared/lib/use-dashboard-refresh";
import type {
  DashboardAnalytics,
  DashboardFilterMetadata,
  DashboardTab,
  DashboardTrendPoint,
} from "@/types/dashboard";
import { SystemDashboardsClient } from "@/components/dashboard/system-dashboard-client";
import { MyWorkbenchDashboardClient } from "@/components/dashboard/my-workbench-dashboard-client";

type DashboardState = {
  loading: boolean;
  error: string | null;
  data: DashboardAnalytics | null;
};

type BlockerView = "all" | "bugs" | "tests" | "requirements";

/** Auto-refresh cadence while the Dashboards page is open and idle. */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;
/** On returning to the tab, refresh immediately if the data is at least this old. */
const STALE_THRESHOLD_MS = 2 * 60_000;
/** Treat the user as "editing filters" for this long after their last change. */
const FILTER_SETTLE_MS = 1_500;

const emptyMetadata: DashboardFilterMetadata = {
  testPlans: [],
  testSuites: [],
  areas: [],
  iterations: [],
  workItemTypes: [],
  assignees: [],
};

export function DashboardsClient() {
  const [activeDashboard, setActiveDashboard] = useState<"workbench" | "project" | "system">("workbench");

  return (
    <Tabs value={activeDashboard} onValueChange={(value) => setActiveDashboard(value as "workbench" | "project" | "system")} className="flex-col gap-4">
      <TabsList variant="primary" className="grid h-auto w-full grid-cols-3 sm:inline-grid sm:w-fit sm:min-w-[640px]">
        <TabsTrigger value="workbench" className="h-10 px-3 py-2 duration-200">My Workbench</TabsTrigger>
        <TabsTrigger value="project" className="h-10 px-3 py-2 duration-200">Project Dashboards</TabsTrigger>
        <TabsTrigger value="system" className="h-10 px-3 py-2 duration-200">System Dashboards</TabsTrigger>
      </TabsList>
      <TabsContent value="workbench" forceMount hidden={activeDashboard !== "workbench"} className="space-y-4">
        <MyWorkbenchDashboardClient active={activeDashboard === "workbench"} />
      </TabsContent>
      <TabsContent value="project" forceMount hidden={activeDashboard !== "project"} className="space-y-4">
        <ProjectDashboardsClient active={activeDashboard === "project"} />
      </TabsContent>
      <TabsContent value="system" forceMount hidden={activeDashboard !== "system"} className="space-y-4">
        <SystemDashboardsClient active={activeDashboard === "system"} />
      </TabsContent>
    </Tabs>
  );
}

function ProjectDashboardsClient({ active }: { active: boolean }) {
  const scope = useActiveProject();
  const previousProjectId = useRef<string | null>(null);
  const bypassCacheRef = useRef(false);
  const [filters, setFilters] = useState<DashboardFilterState>(defaultDashboardFilters);
  const [state, setState] = useState<DashboardState>({ loading: true, error: null, data: null });
  const [activeTab, setActiveTab] = useState<DashboardTab>("testing");
  const [blockerView, setBlockerView] = useState<BlockerView>("all");

  const requestBody = useMemo(() => ({
    scope,
    filters: {
      datePreset: filters.datePreset,
      from: filters.from || undefined,
      to: filters.to || undefined,
      testPlanId: filters.testPlanId,
      testSuiteIds: filters.testSuiteIds,
      areaPath: filters.areaPath,
      iterationPath: filters.iterationPath,
      workItemTypes: filters.workItemTypes,
      assignee: filters.assignee,
    },
  }), [filters, scope]);

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
    // The project dashboard forces a fresh build on any explicit refresh.
    onTrigger: () => { bypassCacheRef.current = true; },
  });

  useEffect(() => {
    const projectId = scope?.azureProjectId ?? null;
    if (projectId !== previousProjectId.current) {
      previousProjectId.current = projectId;
      setFilters(defaultDashboardFilters);
      setState({ loading: Boolean(scope), error: null, data: null });
      setActiveTab("testing");
    }
  }, [scope]);

  useEffect(() => {
    if (!active) return;
    if (scope === undefined) return;
    if (!scope) {
      setState({ loading: false, error: null, data: null });
      return;
    }
    const controller = new AbortController();
    void (async () => {
      // Capture and clear the project-only bypass-cache flag for exactly this attempt.
      const bypassCache = bypassCacheRef.current;
      bypassCacheRef.current = false;
      // A background (auto) refresh stays quiet: it never flips the full-page loading
      // state, so existing data and filters remain interactive while it runs.
      const background = beginFetch();
      if (!background) {
        setState((current) => ({ ...current, loading: true, error: null }));
      }
      try {
        const response = await fetch("/api/dashboard/analytics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...requestBody, bypassCache }),
          signal: controller.signal,
          cache: "no-store",
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Dashboard analytics failed.");
        setState({ loading: false, error: null, data: json as DashboardAnalytics });
        setRefreshFailed(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (background) {
          // Keep the last good data on screen; surface a quiet, non-blocking notice.
          setRefreshFailed(true);
        } else {
          setState((current) => ({
            loading: false,
            error: error instanceof Error ? error.message : "Dashboard analytics failed.",
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
  }, [active, requestBody, scope, refreshToken, beginFetch, settleFetch, setRefreshFailed]);

  // Applying a filter triggers its own fetch (which re-anchors the auto-refresh timer);
  // markInteracting also flags a short settle window so an auto-refresh never fires
  // mid-edit when the user is still adjusting controls.
  function handleFiltersChange(next: DashboardFilterState) {
    setFilters(next);
    markInteracting();
  }

  if (scope === undefined) return <LoadingState rows={8} />;
  if (!scope) {
    return <EmptyState title="Select an Azure DevOps project" description="Use the project selector in the top bar to load testing progress, bugs, coverage, and release readiness." />;
  }

  const data = state.data;
  const metadata = data?.filterMetadata ?? emptyMetadata;
  const section = data?.metadata.sections;
  const blockerBugs = data ? data.bugStatus.agingBugs.filter((bug) => bug.severity === "Critical" || bug.severity === "High") : [];

  function refresh() {
    triggerRefresh(false);
  }

  function navigate(target: DashboardTab | "readiness") {
    if (target === "readiness") {
      document.getElementById("release-readiness")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    setActiveTab(target);
    window.setTimeout(() => document.getElementById("dashboard-details")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  return (
    <div className="space-y-4">
      <DashboardFilters value={filters} effective={data?.filters} metadata={metadata} disabled={state.loading && !data} onChange={handleFiltersChange} />

      <ReportingScope
        projectName={scope.azureProjectName}
        data={data}
        filters={filters}
        metadata={metadata}
        loading={state.loading}
        refreshing={fetching}
        refreshFailed={refreshFailed}
        nextRefreshAt={nextRefreshAt}
        onRefresh={refresh}
      />

      {state.error ? <ErrorState title="Dashboard refresh failed" message={state.error} onRetry={refresh} /> : null}
      {data?.metadata.warnings.length ? <DataQualityNotice warnings={data.metadata.warnings} /> : null}

      {!data && state.loading ? <DashboardKpiGrid loading onNavigate={navigate} /> : null}
      {data ? (
        <>
          <ReleaseReadinessCard data={data.releaseReadiness} />
          <ActionRequiredPanel actions={data.actions} onNavigate={navigate} />
          <DashboardKpiGrid data={data} loading={state.loading} onNavigate={navigate} />
          <ReleaseBlockersTable rows={data.releaseReadiness.blockers} onViewAll={() => { setBlockerView("all"); navigate("blockers"); }} />

          <Tabs id="dashboard-details" value={activeTab} onValueChange={(value) => setActiveTab(value as DashboardTab)} className="w-full min-w-0 scroll-mt-20 flex-col gap-4">
            <div className="max-w-full overflow-x-auto pb-1">
              <TabsList variant="primary" className="h-10 min-w-max shrink-0 justify-start border-border/80 bg-muted/60 p-1 shadow-none">
                <TabsTrigger value="testing" className="h-8 flex-none px-4">Testing Progress</TabsTrigger>
                <TabsTrigger value="bugs" className="h-8 flex-none px-4">Bug Status</TabsTrigger>
                <TabsTrigger value="coverage" className="h-8 flex-none px-4">Coverage & Risk</TabsTrigger>
                <TabsTrigger value="blockers" className="h-8 flex-none px-4">Blockers</TabsTrigger>
                <TabsTrigger value="trends" className="h-8 flex-none px-4">Trends</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="testing" className="w-full min-w-0 space-y-4">
              {section?.testExecution.status !== "available" ? <SectionNotice message={section?.testExecution.message} /> : null}
              <div className="grid gap-4 xl:grid-cols-2">
                <DashboardChartCard title="Test Execution Status" description="Latest outcome for each selected Azure Test Plan point." hasData={hasValues(data.testingProgress.statusDistribution)} emptyMessage={section?.testExecution.message ?? "No test execution data is available."} summary={distributionSummary(data.testingProgress.statusDistribution)}>
                  <DonutChart data={data.testingProgress.statusDistribution} centerLabel="Test points" />
                </DashboardChartCard>
                <DashboardChartCard
                  title="Top 10 Execution Risk by Test Suite"
                  description="Latest outcome distribution across the selected Test Suites. Full suite names are available in tooltips."
                  hasData={Boolean(data.testingProgress.byModule.length)}
                  emptyMessage={section?.testExecution.message ?? "No module execution data is available."}
                >
                  <ExecutionStackedBarChart data={data.testingProgress.byModule} />
                </DashboardChartCard>
              </div>
              <DashboardChartCard title="Execution and Pass Rate Trend" description="Daily completed Azure Test Results in the selected range; values are not cumulative." hasData={hasTrend(data.testingProgress.trend, ["executed", "passRate"])} emptyMessage={section?.trends.message ?? "No test execution data was recorded in this range."} notice={sparseTrendMessage(data.testingProgress.trend, ["executed", "passRate"])}>
                <TrendLineChart data={data.testingProgress.trend} series={[
                  { key: "executed", label: "Executed", color: "hsl(var(--chart-1))" },
                  { key: "passRate", label: "Pass Rate", color: "hsl(var(--success))", yAxisId: "right" },
                ]} />
              </DashboardChartCard>
              <TestingProgressTable rows={data.testingProgress.table} />
            </TabsContent>

            <TabsContent value="bugs" className="w-full min-w-0 space-y-4">
              {section?.bugs.status !== "available" ? <SectionNotice message={section?.bugs.message} /> : null}
              <div className="grid gap-4 xl:grid-cols-2">
                <DashboardChartCard title="Open Bugs by Severity" hasData={hasValues(data.bugStatus.bySeverity)} emptyMessage={section?.bugs.message ?? "No open bugs matched the selected filters."} summary={distributionSummary(data.bugStatus.bySeverity)}>
                  <DistributionBarChart data={data.bugStatus.bySeverity} />
                </DashboardChartCard>
                <DashboardChartCard title="Open Bugs by Priority" description="Microsoft.VSTS.Common.Priority for bugs not in a completed or removed state." hasData={hasValues(data.bugStatus.byPriority)} emptyMessage={section?.bugs.message ?? "No open bugs matched the selected filters."} summary={distributionSummary(data.bugStatus.byPriority)}>
                  <DistributionBarChart data={data.bugStatus.byPriority} />
                </DashboardChartCard>
              </div>
              <DashboardChartCard
                title="Bugs Pending Closure by State"
                description={`Resolved or fixed items remain here until verification and final closure. ${data.bugStatus.closedCount} completed ${data.bugStatus.closedCount === 1 ? "bug is" : "bugs are"} excluded.`}
                hasData={hasValues(data.bugStatus.byStatus)}
                emptyMessage={section?.bugs.message ?? "No bugs are pending closure in this view."}
                summary={distributionSummary(bugWorkflowData(data.bugStatus.byStatus))}
              >
                <DonutChart data={bugWorkflowData(data.bugStatus.byStatus)} centerLabel="Pending closure" />
              </DashboardChartCard>
              <DashboardChartCard title="Daily Bug State Events" description="Bugs opened, completed, or reopened per day. Values are daily events, not the current backlog." hasData={hasTrend(data.bugStatus.openClosedTrend, ["opened", "closed", "reopened"])} emptyMessage={section?.trends.message ?? "No bug events were recorded in this range."} notice={sparseTrendMessage(data.bugStatus.openClosedTrend, ["opened", "closed", "reopened"])}>
                <TrendLineChart data={data.bugStatus.openClosedTrend} series={[
                  { key: "opened", label: "Opened", color: "hsl(var(--destructive))" },
                  { key: "closed", label: "Completed", color: "hsl(var(--success))" },
                  { key: "reopened", label: "Reopened", color: "hsl(var(--warning))" },
                ]} />
              </DashboardChartCard>
              <AgingBugsTable rows={data.bugStatus.agingBugs} />
              <AgingBugsTable rows={data.bugStatus.reopenedBugs} title="Reopened Bugs" compactEmpty />
            </TabsContent>

            <TabsContent value="coverage" className="w-full min-w-0 space-y-4">
              {section?.coverage.status !== "available" ? <SectionNotice message={section?.coverage.message} /> : null}
              <div className="grid gap-4 xl:grid-cols-2">
                <DashboardChartCard
                  title="Requirements Coverage"
                  description="Coverage is based on linked test cases and is independent of whether those tests pass."
                  hasData={hasValues(data.coverage.coveredVsUncovered)}
                  emptyMessage={section?.coverage.message ?? "No requirement coverage data is available."}
                  summary={distributionSummary(data.coverage.coveredVsUncovered)}
                  className={coverageBreakdown(data) ? undefined : "xl:col-span-2"}
                >
                  <DonutChart data={data.coverage.coveredVsUncovered} centerLabel="Requirements" />
                </DashboardChartCard>
                {coverageBreakdown(data) ? (
                  <DashboardChartCard title={coverageBreakdown(data)?.title ?? "Coverage Breakdown"} description={coverageBreakdown(data)?.description} hasData emptyMessage="No coverage breakdown is available.">
                    <CoverageBarChart data={coverageBreakdown(data)?.rows ?? []} />
                  </DashboardChartCard>
                ) : null}
              </div>
              <CoverageMatrixTable rows={data.coverage.coverageGaps} title="Coverage Gaps" />
              <CoverageMatrixTable rows={data.coverage.executionRiskRequirements} title="Execution Risk Requirements" />
              <CoverageMatrixTable rows={data.coverage.matrix} />
            </TabsContent>

            <TabsContent value="blockers" className="w-full min-w-0 space-y-4">
              <Tabs id="blocker-views" value={blockerView} onValueChange={(value) => setBlockerView(value as BlockerView)} className="w-full min-w-0 flex-col gap-4">
                <TabsList className="h-9 w-fit max-w-full shrink-0 justify-start gap-1 overflow-x-auto">
                  <TabsTrigger value="all" className="group/tabs-trigger flex-none gap-1.5 px-3">All<BlockerCount value={data.releaseReadiness.blockers.length} /></TabsTrigger>
                  <TabsTrigger value="bugs" className="group/tabs-trigger flex-none gap-1.5 px-3">Bugs<BlockerCount value={blockerBugs.length} /></TabsTrigger>
                  <TabsTrigger value="tests" className="group/tabs-trigger flex-none gap-1.5 px-3">Blocked Tests<BlockerCount value={data.blockers.aging.length} /></TabsTrigger>
                  <TabsTrigger value="requirements" className="group/tabs-trigger flex-none gap-1.5 px-3">Uncovered Requirements<BlockerCount value={data.coverage.coverageGaps.length} /></TabsTrigger>
                </TabsList>

                <TabsContent value="all" className="w-full min-w-0 space-y-4">
                  <ReleaseBlockersTable rows={data.releaseReadiness.blockers} title="All Release Blockers" maxRows={Number.POSITIVE_INFINITY} />
                </TabsContent>

                <TabsContent value="bugs" className="w-full min-w-0 space-y-4">
                  <AgingBugsTable rows={blockerBugs} title="Blocker Bugs (Critical / High)" />
                </TabsContent>

                <TabsContent value="tests" className="w-full min-w-0 space-y-4">
                  {isUnknownOnly(data.blockers.byReason) ? (
                    <DataQualityInsight
                      title="Blocker reason data is unavailable"
                      message={`Blocked reason is unavailable for ${data.blockers.aging.length} blocked ${data.blockers.aging.length === 1 ? "test" : "tests"}. Add the reason to result comments, tags, or a custom field to improve this breakdown.`}
                    />
                  ) : (
                    <DashboardChartCard title="Blockers by Reason" description="Reasons are inferred only from explicit result comments or error text." hasData={hasValues(data.blockers.byReason)} emptyMessage="No blocked tests are present in the selected execution scope." summary={distributionSummary(data.blockers.byReason)}>
                      <DistributionBarChart data={data.blockers.byReason} />
                    </DashboardChartCard>
                  )}
                  <BlockersTable rows={data.blockers.aging} />
                </TabsContent>

                <TabsContent value="requirements" className="w-full min-w-0 space-y-4">
                  <CoverageMatrixTable rows={data.coverage.coverageGaps} title="Uncovered High-Risk Requirements" />
                </TabsContent>
              </Tabs>
            </TabsContent>

            <TabsContent value="trends" className="w-full min-w-0 space-y-4">
              {section?.trends.status !== "available" ? <SectionNotice message={section?.trends.message} /> : null}
              <DashboardChartCard title="Daily Test Execution" description="Completed test outcomes per day. Empty dates after the last recorded result are omitted." hasData={hasTrend(data.trends.execution, ["executed", "passed", "failed", "blocked"])} emptyMessage={section?.trends.message ?? "No test execution data was recorded in this range."} notice={sparseTrendMessage(data.trends.execution, ["executed", "passed", "failed", "blocked"])}>
                <TrendLineChart data={data.trends.execution} series={[
                  { key: "executed", label: "Executed", color: "hsl(var(--chart-1))" },
                  { key: "passed", label: "Passed", color: "hsl(var(--success))" },
                  { key: "failed", label: "Failed", color: "hsl(var(--destructive))" },
                  { key: "blocked", label: "Blocked", color: "hsl(var(--warning))" },
                ]} />
              </DashboardChartCard>
              <DashboardChartCard title="Daily Pass Rate" description="Pass rate for completed results on each day; this is not cumulative." hasData={hasTrend(data.trends.passRate, ["passRate"])} emptyMessage={section?.trends.message ?? "No pass-rate data was recorded in this range."} notice={sparseTrendMessage(data.trends.passRate, ["passRate"])}>
                <TrendLineChart data={data.trends.passRate} series={[{ key: "passRate", label: "Pass Rate", color: "hsl(var(--success))", yAxisId: "right" }]} />
              </DashboardChartCard>
              <DashboardChartCard title="Daily Bug Events" description="Work items opened and completed per day, plus critical/high bugs opened." hasData={hasTrend(data.trends.bugs, ["opened", "closed", "criticalHighOpened"])} emptyMessage={section?.trends.message ?? "No bug events were recorded in this range."} notice={sparseTrendMessage(data.trends.bugs, ["opened", "closed", "criticalHighOpened"])}>
                <TrendLineChart data={data.trends.bugs} series={[
                  { key: "opened", label: "Opened", color: "hsl(var(--destructive))" },
                  { key: "closed", label: "Completed", color: "hsl(var(--success))" },
                  { key: "criticalHighOpened", label: "Critical / High Opened", color: "hsl(var(--warning))" },
                ]} />
              </DashboardChartCard>
            </TabsContent>
          </Tabs>
        </>
      ) : null}
    </div>
  );
}

function ReportingScope({
  projectName,
  data,
  filters,
  metadata,
  loading,
  refreshing,
  refreshFailed,
  nextRefreshAt,
  onRefresh,
}: {
  projectName: string;
  data: DashboardAnalytics | null;
  filters: DashboardFilterState;
  metadata: DashboardFilterMetadata;
  loading: boolean;
  refreshing: boolean;
  refreshFailed: boolean;
  nextRefreshAt: number | null;
  onRefresh: () => void;
}) {
  const chips = scopeChips(filters, data, metadata);
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3 text-card-foreground shadow-sm">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Reporting Scope</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-foreground">{projectName}</div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {data ? `Release health - ${formatDate(data.filters.dateRange.from)} to ${formatDate(data.filters.dateRange.to)}` : "Loading the selected Azure DevOps scope."}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex flex-wrap gap-1.5">{chips.map((chip, index) => <Badge key={`${index}-${chip}`} variant="secondary" className="font-normal">{chip}</Badge>)}</div>
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

function DataQualityNotice({ warnings }: { warnings: string[] }) {
  const multiple = warnings.length > 1;
  return (
    <div className={`flex min-h-9 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${multiple ? "border-warning/35 bg-warning/10" : "border-primary/15 bg-primary/5"}`}>
      <AlertTriangle className={`size-4 shrink-0 ${multiple ? "text-warning" : "text-primary"}`} aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-foreground" title={warnings[0]}>
        <span className="font-medium">Data limitation:</span> {warnings[0]}
      </p>
      <details className="group relative shrink-0">
        <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-xs font-semibold text-primary outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring">
          <span className="sm:hidden">Details{multiple ? ` (${warnings.length})` : ""}</span>
          <span className="hidden sm:inline">View data quality details{multiple ? ` (${warnings.length})` : ""}</span>
        </summary>
        <div className="absolute right-0 z-20 mt-2 w-[min(420px,calc(100vw-2rem))] space-y-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg">
          <div className="text-sm font-semibold">Data quality details</div>
          {warnings.map((warning) => (
            <div key={warning} className="rounded-md border border-warning/20 bg-warning/5 px-3 py-2">
              <p className="text-xs font-medium leading-5 text-foreground">{warning}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{warningImpact(warning)}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function DataQualityInsight({ title, message }: { title: string; message: string }) {
  return (
    <Card className="qa-card border-warning/25 bg-warning/5">
      <CardContent className="flex items-start gap-3 p-4">
        <Info className="mt-0.5 size-4 shrink-0 text-warning" />
        <div><div className="text-sm font-semibold text-foreground">{title}</div><p className="mt-1 text-xs leading-5 text-muted-foreground">{message}</p></div>
      </CardContent>
    </Card>
  );
}

function SectionNotice({ message }: { message?: string }) {
  if (!message) return null;
  return <Alert><AlertTriangle className="size-4" /><AlertTitle>Partial data</AlertTitle><AlertDescription>{message}</AlertDescription></Alert>;
}

function BlockerCount({ value }: { value: number }) {
  return (
    <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums text-muted-foreground group-data-[state=active]/tabs-trigger:bg-primary/15 group-data-[state=active]/tabs-trigger:text-foreground">
      {value}
    </span>
  );
}

function coverageBreakdown(data: DashboardAnalytics) {
  if (data.coverage.byModule.length > 1) {
    return { title: "Coverage by Module", description: "Linked-test coverage across requirement area paths.", rows: data.coverage.byModule };
  }
  if (data.coverage.byPriority.length > 1) {
    return { title: "Coverage by Priority", description: "Priority is used because the selected scope contains only one module.", rows: data.coverage.byPriority };
  }
  return null;
}

function scopeChips(filters: DashboardFilterState, data: DashboardAnalytics | null, metadata: DashboardFilterMetadata) {
  const chips = [datePresetLabel(data?.filters.dateRange.preset ?? filters.datePreset)];
  const suite = filters.testSuiteIds[0] ? metadata.testSuites.find((item) => item.value === filters.testSuiteIds[0])?.label : null;
  chips.push(suite ?? "All suites");
  if (filters.areaPath) chips.push(filters.areaPath);
  if (filters.iterationPath) chips.push(filters.iterationPath);
  if (filters.assignee) chips.push(metadata.assignees.find((item) => item.value === filters.assignee)?.label ?? filters.assignee);
  return chips.slice(0, 5);
}

function datePresetLabel(value: DashboardAnalytics["filters"]["dateRange"]["preset"]) {
  return { "7d": "Last 7 days", "14d": "Last 14 days", "30d": "Last 30 days", current_sprint: "Current sprint", custom: "Custom range" }[value];
}

function warningImpact(warning: string) {
  if (warning.toLowerCase().includes("execution history")) {
    return "Affected metric: execution trends. Older runs may be excluded; narrow the date range or increase the sync/run limit.";
  }
  if (warning.toLowerCase().includes("bug history")) {
    return "Affected metric: bug trends and reopened detection. Older work-item revisions may be excluded.";
  }
  return "Some dashboard metrics may be incomplete for the selected scope. Review the source configuration or narrow the filters.";
}

function isUnknownOnly(data: Array<{ name: string; value: number }>) {
  const populated = data.filter((item) => item.value > 0);
  return populated.length === 1 && populated[0].name.toLowerCase() === "unknown";
}

function hasValues(data: Array<{ value: number }>) {
  return data.some((item) => item.value > 0);
}

function hasTrend(data: DashboardTrendPoint[], keys: Array<keyof DashboardTrendPoint>) {
  return data.some((point) => keys.some((key) => typeof point[key] === "number" && Number(point[key]) > 0));
}

function distributionSummary(data: Array<{ name: string; value: number }>) {
  return data.map((item) => `${item.name}: ${item.value}`).join(". ");
}

function bugWorkflowData(data: Array<{ name: string; value: number; key?: string }>) {
  return data.map((item) => {
    const normalized = item.name.trim().toLowerCase();
    return normalized === "resolved" || normalized === "fixed"
      ? { ...item, name: `${item.name} / Pending Verification` }
      : item;
  });
}

function sparseTrendMessage(data: DashboardTrendPoint[], keys: Array<keyof DashboardTrendPoint>) {
  const recordedDays = data.filter((point) => keys.some((key) => {
    const value = point[key];
    return typeof value === "number" && (key === "passRate" || value > 0);
  })).length;
  if (recordedDays === 0 || recordedDays > 5 || recordedDays === data.length) return null;
  return `Only ${recordedDays} ${recordedDays === 1 ? "day has" : "days have"} recorded results in this range.`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${value}T00:00:00`));
}
