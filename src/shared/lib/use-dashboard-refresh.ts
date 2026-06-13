"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAutoRefresh } from "./use-auto-refresh";

export type UseDashboardRefreshOptions = {
  /**
   * Full condition under which periodic auto-refresh should run — e.g. the tab is
   * active and scope + data (and any required filters) are present.
   */
  enabled: boolean;
  /** True while a foreground (non-quiet) fetch is in flight. */
  loading: boolean;
  intervalMs: number;
  staleMs: number;
  filterSettleMs: number;
  /** Runs when a refresh is triggered (e.g. to set a bypass-cache ref) before the fetch. */
  onTrigger?: (background: boolean) => void;
};

/**
 * Shared refresh orchestration for the project and system dashboards: owns the
 * refresh token, last-fetch anchor, quiet-background and failed flags, the
 * filter-edit settle window, and the auto-refresh scheduling (via useAutoRefresh).
 * The caller keeps its own fetch effect (different endpoints/state) and drives it
 * with `refreshToken`, `beginFetch()`, `settleFetch()` and `setRefreshFailed`.
 */
export function useDashboardRefresh({
  enabled,
  loading,
  intervalMs,
  staleMs,
  filterSettleMs,
  onTrigger,
}: UseDashboardRefreshOptions) {
  const backgroundRef = useRef(false);
  const interactingTimerRef = useRef<number | null>(null);
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const [refreshToken, setRefreshToken] = useState(0);
  const [lastFetchAt, setLastFetchAt] = useState<number | null>(null);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [interacting, setInteracting] = useState(false);

  useEffect(() => () => {
    if (interactingTimerRef.current) window.clearTimeout(interactingTimerRef.current);
  }, []);

  const fetching = loading || backgroundRefreshing;

  const triggerRefresh = useCallback((background: boolean) => {
    onTriggerRef.current?.(background);
    backgroundRef.current = background;
    setRefreshToken((token) => token + 1);
  }, []);

  // Flags the user as actively editing filters for a short settle window so a periodic
  // refresh never fires mid-edit. Applying a filter also re-anchors the timer via the
  // fetch it triggers, so this is belt-and-suspenders for the exact-boundary case.
  const markInteracting = useCallback(() => {
    setInteracting(true);
    if (interactingTimerRef.current) window.clearTimeout(interactingTimerRef.current);
    interactingTimerRef.current = window.setTimeout(() => setInteracting(false), filterSettleMs);
  }, [filterSettleMs]);

  // Read+clear the per-attempt background flag at the start of a fetch and reflect it in
  // the quiet-refresh state. Returns whether this attempt is a quiet background refresh.
  const beginFetch = useCallback(() => {
    const background = backgroundRef.current;
    backgroundRef.current = false;
    setBackgroundRefreshing(background);
    return background;
  }, []);

  // Call when a non-aborted fetch attempt settles, to anchor the next auto-refresh.
  const settleFetch = useCallback(() => {
    setBackgroundRefreshing(false);
    setLastFetchAt(Date.now());
  }, []);

  const { nextRefreshAt } = useAutoRefresh({
    enabled,
    intervalMs,
    staleMs,
    lastFetchAt,
    suspended: interacting || fetching,
    onRefresh: () => triggerRefresh(true),
  });

  return {
    refreshToken,
    fetching,
    refreshFailed,
    setRefreshFailed,
    nextRefreshAt,
    triggerRefresh,
    markInteracting,
    beginFetch,
    settleFetch,
  };
}
