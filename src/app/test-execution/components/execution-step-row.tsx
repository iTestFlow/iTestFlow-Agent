"use client";

import { Loader2 } from "lucide-react";

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
          {step.status === "running" ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          ) : (
            step.index + 1
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 break-words">{step.action}</span>
            <StatusChip tone={runStatusTone(step.status)} className="shrink-0">{runStatusLabel(step.status)}</StatusChip>
          </div>
          <p className="mt-1 text-xs capitalize text-muted-foreground">{step.phase ?? "scenario"}{step.layer ? ` · ${step.layer}` : ""}</p>
          {step.expectedResult ? <p className="mt-1 text-muted-foreground">Expected: {step.expectedResult}</p> : null}
          {step.errorMessage ? <p className="mt-1 text-destructive">{step.errorMessage}</p> : null}
          {step.operations?.length ? <ol className="mt-2 space-y-1 border-l border-border pl-3 text-xs">{step.operations.map((operation) => <li key={operation.id}><span className="font-medium">{operation.connectionAlias ?? operation.alias ?? operation.layer ?? "browser"}</span> · {operation.operation ?? operation.toolName ?? "operation"}{operation.assertion ? ` · ${operation.assertion}` : ""}{operation.durationMs != null ? ` · ${operation.durationMs} ms` : ""}{operation.status ? ` · ${runStatusLabel(operation.status)}` : ""}{operation.errorMessage ? ` · ${operation.errorMessage}` : ""}</li>)}</ol> : null}
          {children}
        </div>
      </div>
    </div>
  );
}
