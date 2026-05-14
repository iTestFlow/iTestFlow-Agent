"use client";

import {
  BrainCircuit,
  ClipboardCheck,
  Database,
  Layers3,
  RefreshCw,
  Send,
  ShieldCheck,
  TestTube2,
  TimerReset,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ActivityBarChart,
  ChartCard,
  HorizontalBarChart,
  InfoBanner,
  MetricCard,
  RecentActivityList,
  StatusBreakdown,
  VerticalBarChart,
} from "@/components/dashboard/analytics-components";
import { Button } from "@/components/ui/button";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import type { DashboardAnalytics } from "@/types/dashboard";

type DashboardState = {
  loading: boolean;
  error: string | null;
  data: DashboardAnalytics | null;
};

function useActiveProject() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  return scope;
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en", { notation: value >= 10000 ? "compact" : "standard" }).format(value);
}

function durationLabel(value: number) {
  if (!value) return "0 ms";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function formatGeneratedAt(value?: string) {
  if (!value) return "Not loaded";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function DashboardClient() {
  const scope = useActiveProject();
  const [state, setState] = useState<DashboardState>({ loading: true, error: null, data: null });

  const body = useMemo(() => ({ scope }), [scope]);

  async function loadAnalytics() {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch("/api/dashboard/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Dashboard analytics failed.");
      setState({ loading: false, error: null, data: json });
    } catch (error) {
      setState({
        loading: false,
        error: error instanceof Error ? error.message : "Dashboard analytics failed.",
        data: null,
      });
    }
  }

  useEffect(() => {
    void loadAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const data = state.data;
  const kpis = data?.kpis;

  return (
    <div className="space-y-5">
      <InfoBanner
        title={scope?.azureProjectName ? `${scope.azureProjectName} analytics` : "All local project analytics"}
        description="Live metrics from local workflow history, indexed Azure DevOps context, LLM requests, publishing runs, and audit logs."
        action={
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-border bg-background/70 px-3 py-1.5 text-xs text-muted-foreground md:inline-flex">
              Updated {formatGeneratedAt(data?.generatedAt)}
            </span>
            <Button size="sm" variant="outline" onClick={() => void loadAnalytics()} disabled={state.loading}>
              <RefreshCw className={state.loading ? "size-4 animate-spin" : "size-4"} />
              Refresh
            </Button>
          </div>
        }
      />

      {state.error ? (
        <div className="rounded-2xl border border-red-500/25 bg-red-500/10 p-4 text-sm text-red-700 dark:text-red-200">
          {state.error}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Indexed Work Items" value={compactNumber(kpis?.indexedWorkItems ?? 0)} description="Azure DevOps items available to local context." icon={Database} tone="blue" />
        <MetricCard title="Context Chunks" value={compactNumber(kpis?.contextChunks ?? 0)} description="Searchable RAG chunks extracted locally." icon={Layers3} tone="cyan" />
        <MetricCard title="Requirement Runs" value={compactNumber(kpis?.requirementRuns ?? 0)} description="Requirement analysis executions." icon={ShieldCheck} tone="green" />
        <MetricCard title="Generated Cases" value={compactNumber(kpis?.generatedCases ?? 0)} description="Draft test cases created by workflows." icon={TestTube2} tone="purple" />
        <MetricCard title="Coverage Reviews" value={compactNumber(kpis?.coverageReviews ?? 0)} description="Existing test coverage matrix reviews." icon={ClipboardCheck} tone="yellow" />
        <MetricCard title="Publish Attempts" value={compactNumber(kpis?.publishAttempts ?? 0)} description="Push runs toward Azure Test Plans." icon={Send} tone="red" />
        <MetricCard title="LLM Success Rate" value={`${kpis?.llmSuccessRate ?? 0}%`} description="Validated local LLM request success." icon={BrainCircuit} tone="green" />
        <MetricCard title="Avg LLM Latency" value={durationLabel(kpis?.averageLlmDurationMs ?? 0)} description="Average duration across logged calls." icon={TimerReset} tone="blue" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <ChartCard title="Workflow Activity" description="Requirement, test design, coverage, and publish runs over the last 14 days." marker="blue">
          <ActivityBarChart data={data?.charts.activityByDay ?? []} />
        </ChartCard>
        <ChartCard title="Audit Status" description="Recent local workflow outcomes grouped by audit status." marker="green">
          <StatusBreakdown data={data?.charts.auditStatus ?? []} />
        </ChartCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="Work Item States" description="Indexed Azure DevOps work item status distribution." marker="cyan">
          <VerticalBarChart data={data?.charts.workItemStates ?? []} />
        </ChartCard>
        <ChartCard title="LLM Provider Health" description="Logged LLM request status grouped by provider." marker="purple">
          <HorizontalBarChart data={data?.charts.llmProviderStatus ?? []} />
        </ChartCard>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(360px,0.8fr)_minmax(0,1.2fr)]">
        <ChartCard title="Publish Outcomes" description="Azure Test Plans publish run outcomes." marker="yellow">
          <StatusBreakdown data={data?.charts.publishOutcomes ?? []} />
        </ChartCard>
        <ChartCard title="Recent Activity" description="Latest local workflow audit entries." marker="red">
          <RecentActivityList items={data?.recentActivity ?? []} />
        </ChartCard>
      </div>
    </div>
  );
}
