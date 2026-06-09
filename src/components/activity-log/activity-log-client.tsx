"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ChartCard,
  InfoBanner,
  RecentActivityList,
} from "@/components/dashboard/analytics-components";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/qa/callout";
import { useActiveProject } from "@/shared/lib/use-active-project";
import type { DashboardAnalytics } from "@/types/dashboard";

type ActivityLogState = {
  loading: boolean;
  error: string | null;
  data: DashboardAnalytics | null;
};

const RECENT_ACTIVITY_INITIAL_LIMIT = 20;
const RECENT_ACTIVITY_LOAD_INCREMENT = 20;
const RECENT_ACTIVITY_MAX_LIMIT = 100;

function formatGeneratedAt(value?: string) {
  if (!value) return "Not loaded";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ActivityLogClient() {
  const scope = useActiveProject();
  const [state, setState] = useState<ActivityLogState>({ loading: true, error: null, data: null });
  const [recentActivityLimit, setRecentActivityLimit] = useState(RECENT_ACTIVITY_INITIAL_LIMIT);

  const body = useMemo(() => ({ scope: scope ?? null, recentActivityLimit }), [recentActivityLimit, scope]);

  async function loadActivity() {
    if (scope === undefined) return;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const response = await fetch("/api/dashboard/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Recent activity failed to load.");
      setState({ loading: false, error: null, data: json });
    } catch (error) {
      setState({
        loading: false,
        error: error instanceof Error ? error.message : "Recent activity failed to load.",
        data: null,
      });
    }
  }

  useEffect(() => {
    if (scope === undefined) return;
    void loadActivity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, scope]);

  function loadMoreRecentActivity() {
    setRecentActivityLimit((current) => Math.min(current + RECENT_ACTIVITY_LOAD_INCREMENT, RECENT_ACTIVITY_MAX_LIMIT));
  }

  const data = state.data;

  return (
    <div className="space-y-5">
      <InfoBanner
        title={scope === undefined ? "Loading activity" : scope?.azureProjectName ? `${scope.azureProjectName} activity` : "All local project activity"}
        description="Recent local workflow audit entries, generated outputs, and user actions, scoped to the active project."
        action={
          <div className="flex items-center gap-2">
            <span className="hidden rounded-full border border-border bg-background/70 px-3 py-1.5 text-xs text-muted-foreground md:inline-flex">
              Updated {formatGeneratedAt(data?.generatedAt)}
            </span>
            <Button size="sm" variant="outline" onClick={() => void loadActivity()} disabled={state.loading}>
              <RefreshCw className={state.loading ? "size-4 animate-spin" : "size-4"} />
              Refresh
            </Button>
          </div>
        }
      />

      {state.error ? <Callout tone="error">{state.error}</Callout> : null}

      <ChartCard title="Recent Activity" description="Latest local workflow audit entries." marker="red">
        <RecentActivityList
          items={data?.recentActivity ?? []}
          hasMore={data?.recentActivityHasMore ?? false}
          loadingMore={state.loading && Boolean(data)}
          onLoadMore={loadMoreRecentActivity}
        />
      </ChartCard>
    </div>
  );
}
