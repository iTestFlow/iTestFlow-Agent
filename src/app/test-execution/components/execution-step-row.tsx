"use client";

import { StatusChip } from "@/components/qa/status-chip";
import { cn } from "@/lib/utils";
import { runStatusLabel, runStatusTone, type RunStatus, type RunStep } from "../lib/run-types";

function stepNumberClass(status: RunStatus): string {
  switch (status) {
    case "passed": return "bg-success/10 text-success";
    case "failed":
    case "error": return "bg-destructive/10 text-destructive";
    case "running": return "bg-primary/10 text-primary";
    default: return "bg-muted text-muted-foreground";
  }
}

/** Read-only step row shared by the live progress view and the results step. */
export function ExecutionStepRow({ step, children }: { step: RunStep; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 text-sm">
      <div className="flex items-start gap-3">
        <span className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums", stepNumberClass(step.status))}>
          {step.index + 1}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words">{step.action}</span>
            <StatusChip tone={runStatusTone(step.status)} className="shrink-0">{runStatusLabel(step.status)}</StatusChip>
          </div>
          {step.expectedResult ? <p className="mt-1 text-muted-foreground">Expected: {step.expectedResult}</p> : null}
          {step.errorMessage ? <p className="mt-1 text-destructive">{step.errorMessage}</p> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
