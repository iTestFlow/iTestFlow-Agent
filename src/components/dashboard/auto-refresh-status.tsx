"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Live "Last updated … · Next refresh in m:ss" status line shared by the project and
 * system dashboards. Runs its own one-second ticker so only this leaf re-renders on
 * the countdown, not the whole dashboard. Shows a quiet "Refreshing" / "Refresh failed"
 * indicator instead of the countdown while a background refresh is in flight or failed.
 */
export function AutoRefreshStatus({
  generatedAt,
  nextRefreshAt,
  refreshing,
  failed,
}: {
  generatedAt?: string;
  nextRefreshAt: number | null;
  refreshing: boolean;
  failed: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (nextRefreshAt === null || refreshing) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [nextRefreshAt, refreshing]);

  const secondsRemaining = nextRefreshAt === null
    ? null
    : Math.max(0, Math.round((nextRefreshAt - now) / 1000));

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Last updated {formatGeneratedAt(generatedAt)}</span>
      {refreshing ? (
        <span className="flex items-center gap-1 text-primary"><RefreshCw className="size-3 animate-spin" />Refreshing</span>
      ) : failed ? (
        <span className="flex items-center gap-1 text-warning"><AlertTriangle className="size-3" />Refresh failed</span>
      ) : secondsRemaining !== null ? (
        <span>· Next refresh in {formatCountdown(secondsRemaining)}</span>
      ) : (
        <span>· Auto-refresh paused</span>
      )}
    </span>
  );
}

export function formatGeneratedAt(value?: string) {
  if (!value) return "not loaded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatCountdown(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
