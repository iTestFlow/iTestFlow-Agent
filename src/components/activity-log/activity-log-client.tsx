"use client";

import { RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ChartCard,
  InfoBanner,
  RecentActivityList,
} from "@/components/dashboard/analytics-components";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Callout } from "@/components/qa/callout";
import { DataToolbar } from "@/components/qa/data-toolbar";
import { useActiveProject } from "@/shared/lib/use-active-project";
import type { ActivityLogResult } from "@/types/activity-log";

type ActivityLogState = {
  loading: boolean;
  error: string | null;
  data: ActivityLogResult | null;
};

const RECENT_ACTIVITY_INITIAL_LIMIT = 20;
const RECENT_ACTIVITY_LOAD_INCREMENT = 20;
const RECENT_ACTIVITY_MAX_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 300;

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

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [group, setGroup] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const hasActiveFilters = search.trim() !== "" || group !== "all" || from !== "" || to !== "";

  // Debounce the free-text search and reset pagination so a new query starts at page one.
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search);
      setRecentActivityLimit(RECENT_ACTIVITY_INITIAL_LIMIT);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [search]);

  const body = useMemo(
    () => ({
      scope: scope ?? null,
      search: debouncedSearch.trim(),
      groups: group === "all" ? [] : [group],
      from: from || undefined,
      to: to || undefined,
      limit: recentActivityLimit,
    }),
    [scope, debouncedSearch, group, from, to, recentActivityLimit],
  );

  // A new AbortController per request guarantees a slow earlier response cannot overwrite
  // newer filter state; the cleanup aborts the in-flight request when the body changes.
  useEffect(() => {
    if (scope === undefined) return;
    const controller = new AbortController();

    void (async () => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const response = await fetch("/api/activity-log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Activity log failed to load.");
        setState({ loading: false, error: null, data: json as ActivityLogResult });
      } catch (error) {
        if (controller.signal.aborted) return; // superseded by a newer request
        setState({
          loading: false,
          error: error instanceof Error ? error.message : "Activity log failed to load.",
          data: null,
        });
      }
    })();

    return () => controller.abort();
  }, [body, scope, reloadToken]);

  function loadMoreRecentActivity() {
    setRecentActivityLimit((current) => Math.min(current + RECENT_ACTIVITY_LOAD_INCREMENT, RECENT_ACTIVITY_MAX_LIMIT));
  }

  function changeGroup(value: string) {
    setGroup(value);
    setRecentActivityLimit(RECENT_ACTIVITY_INITIAL_LIMIT);
  }

  function changeFrom(value: string) {
    setFrom(value);
    setRecentActivityLimit(RECENT_ACTIVITY_INITIAL_LIMIT);
  }

  function changeTo(value: string) {
    setTo(value);
    setRecentActivityLimit(RECENT_ACTIVITY_INITIAL_LIMIT);
  }

  function clearFilters() {
    setSearch("");
    setDebouncedSearch("");
    setGroup("all");
    setFrom("");
    setTo("");
    setRecentActivityLimit(RECENT_ACTIVITY_INITIAL_LIMIT);
  }

  const data = state.data;
  const actionOptions = data?.availableActions ?? [];

  return (
    <div className="space-y-5">
      <InfoBanner
        title={scope === undefined ? "Loading activity" : scope?.azureProjectName ? `${scope.azureProjectName} activity` : "All local project activity"}
        description="Recent local workflow audit entries, generated outputs, and user actions, scoped to the active project."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="inline-flex rounded-full border border-border bg-background/70 px-3 py-1.5 text-xs tabular-nums text-muted-foreground">
              Updated {formatGeneratedAt(data?.generatedAt)}
            </span>
            <Button size="sm" variant="outline" aria-busy={state.loading} onClick={() => setReloadToken((token) => token + 1)} disabled={state.loading}>
              <RefreshCw className={state.loading ? "size-4 motion-safe:animate-spin" : "size-4"} aria-hidden="true" />
              Refresh
            </Button>
          </div>
        }
      />

      {state.error ? <Callout tone="error" role="alert">{state.error}</Callout> : null}

      <ChartCard title="Recent Activity" description="Latest local workflow audit entries." marker="red">
        <div className="-mx-5 mb-4 border-y border-border bg-muted/20">
          <DataToolbar
            className="border-b-0 px-5"
            searchPlaceholder="Search by message, action, entity, or user"
            searchValue={search}
            onSearchChange={setSearch}
            filters={
              <>
                <Select value={group} onValueChange={changeGroup}>
                  <SelectTrigger className="h-8 w-full min-w-0 sm:w-[200px]" aria-label="Activity type">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {actionOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div role="group" aria-label="Date range" className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                  <Input
                    type="date"
                    aria-label="From date"
                    value={from}
                    max={to || undefined}
                    onChange={(event) => changeFrom(event.target.value)}
                    className="h-8 w-full min-w-0 sm:w-[150px]"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <Input
                    type="date"
                    aria-label="To date"
                    value={to}
                    min={from || undefined}
                    onChange={(event) => changeTo(event.target.value)}
                    className="h-8 w-full min-w-0 sm:w-[150px]"
                  />
                </div>
                {hasActiveFilters ? (
                  <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                    <X className="size-4" aria-hidden="true" />
                    Clear
                  </Button>
                ) : null}
              </>
            }
          />
        </div>

        <RecentActivityList
          items={data?.items ?? []}
          hasMore={data?.hasMore ?? false}
          loadingMore={state.loading && Boolean(data)}
          onLoadMore={loadMoreRecentActivity}
          emptyLabel={state.loading && !data ? "Loading activity…" : hasActiveFilters ? "No activity matches your filters" : "No recent local activity yet"}
        />
      </ChartCard>
    </div>
  );
}
