"use client";

import { History, Pencil, Eye } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/qa/status-chip";
import { RefreshButton } from "@/components/qa/refresh-button";
import { SectionCard } from "@/components/workflow/test-intelligence-shared";
import { isLiveRunStatus, runStatusLabel, runStatusTone, type RunSummary } from "../lib/run-types";

/**
 * Persistent run history below the stepper. Any finished run can be viewed
 * or staged for an editable rerun.
 */
export function RunHistoryCard({
  runs,
  loading,
  busy,
  onRefresh,
  onView,
  onRerun,
}: {
  runs: RunSummary[];
  loading: boolean;
  /** Disables rerun staging while a run is live or a rerun is being loaded. */
  busy: boolean;
  onRefresh: () => void;
  onView: (runId: string) => void;
  onRerun: (runId: string) => void;
}) {
  return (
    <SectionCard
      title="Run history"
      description="Past executions in this project."
      action={<RefreshButton loading={loading} onClick={onRefresh} />}
    >
      <div className="space-y-2 p-4">
        {!runs.length ? (
          <div className="content-empty-state">
            <History className="size-5 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">No executions yet — your finished runs will appear here.</p>
          </div>
        ) : null}
        {runs.map((run) => {
          const live = isLiveRunStatus(run.status);
          return (
            <div key={run.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{run.id}</span>
                  <StatusChip tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusChip>
                </div>
                <p className="text-sm text-muted-foreground">
                  {run.completedCases}/{run.totalCases} case{run.totalCases === 1 ? "" : "s"} · <time dateTime={run.createdAt} className="tabular-nums">{new Date(run.createdAt).toLocaleString()}</time>
                </p>
                {run.errorMessage ? <p className="break-words text-sm text-destructive">{run.errorMessage}</p> : null}
              </div>
              {!live ? (
                <div className="flex shrink-0 gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => onView(run.id)}>
                    <Eye className="size-4" aria-hidden="true" />
                    View results
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onRerun(run.id)}>
                    <Pencil className="size-4" aria-hidden="true" />
                    Rerun
                  </Button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
