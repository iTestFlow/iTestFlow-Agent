"use client";

import { useEffect, useRef, useState } from "react";

export type UseAutoRefreshOptions = {
  /** When false, nothing is scheduled (e.g. there is no data to refresh yet). */
  enabled: boolean;
  /** Auto-refresh cadence in milliseconds, anchored to the last completed fetch. */
  intervalMs: number;
  /** On returning to a visible tab, refresh immediately if the data is at least this old. */
  staleMs: number;
  /** Epoch ms of the last completed fetch; anchors the countdown. Null until the first load. */
  lastFetchAt: number | null;
  /** Pause scheduling while true (user is editing filters or a fetch is already in flight). */
  suspended: boolean;
  /** Triggers a quiet background refresh. */
  onRefresh: () => void;
};

export type UseAutoRefreshResult = {
  /** Epoch ms of the next scheduled auto-refresh, or null when nothing is scheduled. */
  nextRefreshAt: number | null;
  /** True while auto-refresh is paused because the browser tab is hidden. */
  paused: boolean;
};

function isDocumentVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * Schedules a quiet, recurring refresh while a tab is visible and idle:
 * - Fires `onRefresh` every `intervalMs`, anchored to `lastFetchAt` (so applying
 *   filters, which produces a new fetch, naturally restarts the timer).
 * - Pauses while the tab is hidden or `suspended` is true.
 * - On returning to a visible tab, refreshes immediately when the data is older
 *   than `staleMs` instead of waiting for the next tick.
 */
export function useAutoRefresh({
  enabled,
  intervalMs,
  staleMs,
  lastFetchAt,
  suspended,
  onRefresh,
}: UseAutoRefreshOptions): UseAutoRefreshResult {
  const [visible, setVisible] = useState(isDocumentVisible);

  // Keep the latest callback without re-arming the scheduler on every render.
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  // Track tab visibility, and refresh on return when the data is already stale.
  useEffect(() => {
    function handleVisibilityChange() {
      const nowVisible = document.visibilityState === "visible";
      setVisible(nowVisible);
      if (
        nowVisible &&
        enabled &&
        !suspended &&
        lastFetchAt !== null &&
        Date.now() - lastFetchAt >= staleMs
      ) {
        onRefreshRef.current();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [enabled, suspended, lastFetchAt, staleMs]);

  // Schedule the next periodic refresh, anchored to the last completed fetch.
  useEffect(() => {
    if (!enabled || suspended || !visible || lastFetchAt === null) return;
    const delay = Math.max(0, lastFetchAt + intervalMs - Date.now());
    const timer = window.setTimeout(() => onRefreshRef.current(), delay);
    return () => window.clearTimeout(timer);
  }, [enabled, suspended, visible, lastFetchAt, intervalMs]);

  const scheduled = enabled && !suspended && visible && lastFetchAt !== null;
  return {
    nextRefreshAt: scheduled ? lastFetchAt + intervalMs : null,
    paused: enabled && !visible,
  };
}
