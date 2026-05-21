"use client";

import {
  BrainCircuit,
  ClipboardCheck,
  BookOpenCheck,
  Database,
  RefreshCw,
  ShieldCheck,
  TestTube2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ChartCard,
  InfoBanner,
  MetricCard,
  RecentActivityList,
} from "@/components/dashboard/analytics-components";
import { Button } from "@/components/ui/button";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import type { DashboardAnalytics } from "@/types/dashboard";

type DashboardState = {
  loading: boolean;
  error: string | null;
  data: DashboardAnalytics | null;
};

const RECENT_ACTIVITY_INITIAL_LIMIT = 8;
const RECENT_ACTIVITY_LOAD_INCREMENT = 8;
const RECENT_ACTIVITY_MAX_LIMIT = 100;

function useActiveProject() {
  const [scope, setScope] = useState<ActiveProjectScope | null | undefined>(undefined);

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
  const [recentActivityLimit, setRecentActivityLimit] = useState(RECENT_ACTIVITY_INITIAL_LIMIT);

  const body = useMemo(() => ({ scope: scope ?? null, recentActivityLimit }), [recentActivityLimit, scope]);

  async function loadAnalytics() {
    if (scope === undefined) return;
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
    if (scope === undefined) return;
    void loadAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, scope]);

  function loadMoreRecentActivity() {
    setRecentActivityLimit((current) => Math.min(current + RECENT_ACTIVITY_LOAD_INCREMENT, RECENT_ACTIVITY_MAX_LIMIT));
  }

  const data = state.data;
  const kpis = data?.kpis;

  return (
    <div className="space-y-5">
      <InfoBanner
        title={scope === undefined ? "Loading analytics" : scope?.azureProjectName ? `${scope.azureProjectName} analytics` : "All local project analytics"}
        description="Live project metrics from indexed Azure DevOps context, project knowledge, QA workflows, and LLM requests."
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

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <MetricCard title="Indexed Work Items" value={compactNumber(kpis?.indexedWorkItems ?? 0)} description="Azure DevOps items available to local context." icon={Database} tone="blue" />
        <MetricCard title="Business Rules" value={compactNumber(kpis?.businessRules ?? 0)} description="Extracted rules available to QA workflows." icon={BookOpenCheck} tone="cyan" />
        <MetricCard title="Requirement Runs" value={compactNumber(kpis?.requirementRuns ?? 0)} description="Completed requirement analysis workflows." icon={ShieldCheck} tone="green" />
        <MetricCard title="Generated Cases" value={compactNumber(kpis?.generatedCases ?? 0)} description="Draft test cases created by workflows." icon={TestTube2} tone="purple" />
        <MetricCard title="Coverage Reviews" value={compactNumber(kpis?.coverageReviews ?? 0)} description="Completed Test Coverage Matrix reviews." icon={ClipboardCheck} tone="yellow" />
        <MetricCard title="LLM Success Rate" value={`${kpis?.llmSuccessRate ?? 0}%`} description="Validated LLM requests across local workflows." icon={BrainCircuit} tone="green" />
      </div>

      <div className="grid gap-5">
        <ChartCard title="Recent Activity" description="Latest local workflow audit entries." marker="red">
          <RecentActivityList
            items={data?.recentActivity ?? []}
            hasMore={data?.recentActivityHasMore ?? false}
            loadingMore={state.loading && Boolean(data)}
            onLoadMore={loadMoreRecentActivity}
          />
        </ChartCard>
      </div>
    </div>
  );
}
