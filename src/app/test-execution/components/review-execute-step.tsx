"use client";

import { useMemo, useState } from "react";
import { Ban, Loader2, Play, ShieldAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { validateNaturalPlan, type PlanFinding } from "@/modules/test-execution/natural-plan";

import type { DraftCase } from "../lib/draft-storage";
import { layerHintEnvironmentIssue } from "../lib/manual-step-form";
import type { RunDetailDto } from "@/modules/test-execution/report-assembler";
import { OutcomeBadge } from "./outcome-badge";

/**
 * Review & Execute: the approval gate (policy warnings surfaced before the
 * single Approve action) that transitions in-step into live progress once the
 * run is queued. Cancel is a confirmed destructive action and stays reachable
 * for the whole run.
 */

export function ReviewExecuteStep({
  cases,
  environmentLabel,
  allowedOrigin,
  environmentTargets,
  capabilityCount,
  availableSecretNames,
  storyWorkItemId,
  run,
  creating,
  onApprove,
  onCancelRun,
  cancelPending,
  onBack,
  onViewResults,
}: {
  cases: DraftCase[];
  environmentLabel: string;
  allowedOrigin: string;
  environmentTargets: Array<"UI" | "API" | "DB">;
  capabilityCount: number;
  availableSecretNames: string[];
  storyWorkItemId: string | null;
  run: RunDetailDto | null;
  creating: boolean;
  onApprove: () => Promise<void>;
  onCancelRun: () => Promise<void>;
  cancelPending: boolean;
  onBack: () => void;
  onViewResults: () => void;
}) {
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  const findings = useMemo<PlanFinding[]>(() => {
    const all: PlanFinding[] = [];
    for (const entry of cases) {
      const result = validateNaturalPlan(entry.plan, { availableSecretNames });
      all.push(...result.findings.map((finding) => ({ ...finding, message: `${entry.title}: ${finding.message}` })));
      entry.plan.steps.forEach((step, stepIndex) => {
        const hint = step.layerHint ?? "auto";
        const layerIssue = layerHintEnvironmentIssue(hint, environmentTargets);
        if (layerIssue) {
          all.push({
            severity: "error",
            code: "invalid_plan",
            stepIndex,
            message: `${entry.title}: Step ${stepIndex + 1} ${layerIssue}`,
          });
        }
      });
    }
    return all;
  }, [cases, availableSecretNames, environmentTargets]);
  const blocking = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  const totalSteps = cases.reduce((sum, entry) => sum + entry.plan.steps.length, 0);
  const hintCounts = cases.flatMap((entry) => entry.plan.steps).reduce<Record<string, number>>((counts, step) => {
    const hint = step.layerHint ?? "auto";
    counts[hint] = (counts[hint] ?? 0) + 1;
    return counts;
  }, {});
  const running = run !== null && (run.run.status === "queued" || run.run.status === "running");
  const terminal = run !== null && !running;

  if (run === null) {
    return (
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Review before execution</CardTitle>
            <CardDescription>
              Approving freezes the plan, the environment, and immutable source snapshots, then queues the run on the execution worker.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="font-medium">{environmentLabel}</dd>
              </div>
              <div className="flex items-center justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Targets</dt>
                <dd className="flex flex-wrap gap-1">
                  {environmentTargets.map((target) => <Badge key={target} variant="outline">{target}</Badge>)}
                </dd>
              </div>
              {allowedOrigin ? (
                <div className="flex justify-between gap-2 sm:justify-start">
                  <dt className="text-muted-foreground">UI origin</dt>
                  <dd className="truncate font-mono text-xs leading-6">{allowedOrigin}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Test cases</dt>
                <dd className="font-medium tabular-nums">{cases.length}</dd>
              </div>
              <div className="flex justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Total steps</dt>
                <dd className="font-medium tabular-nums">{totalSteps}</dd>
              </div>
              <div className="flex items-start justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Layer guidance</dt>
                <dd className="flex flex-wrap gap-1">
                  {Object.entries(hintCounts).map(([hint, count]) => (
                    <Badge key={hint} variant="secondary" className="uppercase">{hint} {count}</Badge>
                  ))}
                </dd>
              </div>
              <div className="flex justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Approved capabilities</dt>
                <dd className="font-medium tabular-nums">{capabilityCount}</dd>
              </div>
              {storyWorkItemId ? (
                <div className="flex justify-between gap-2 sm:justify-start">
                  <dt className="text-muted-foreground">Source story</dt>
                  <dd className="font-medium">#{storyWorkItemId}</dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2 sm:justify-start">
                <dt className="text-muted-foreground">Execution order</dt>
                <dd>Sequential, shared run context</dd>
              </div>
            </dl>

            {blocking.length > 0 ? (
              <Alert variant="destructive">
                <Ban className="h-4 w-4" aria-hidden />
                <AlertTitle>The plan cannot run yet</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {blocking.slice(0, 8).map((finding, index) => (
                      <li key={index}>{finding.message}</li>
                    ))}
                  </ul>
                  Fix these in Test Scope, then come back.
                </AlertDescription>
              </Alert>
            ) : null}
            {warnings.length > 0 ? (
              <Alert>
                <ShieldAlert className="h-4 w-4" aria-hidden />
                <AlertTitle>Review before approving</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4">
                    {warnings.slice(0, 8).map((finding, index) => (
                      <li key={index}>{finding.message}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>

        <div className="flex justify-between">
          <Button variant="outline" onClick={onBack} disabled={creating}>
            Back
          </Button>
          <Button disabled={creating || blocking.length > 0 || cases.length === 0} onClick={() => void onApprove()}>
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Play className="mr-1 h-4 w-4" aria-hidden />}
            Approve & Execute
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle>
                {running ? "Executing…" : "Execution finished"}
              </CardTitle>
              <CardDescription aria-live="polite">
                Status: {run.run.status.replace(/_/g, " ")}
                {run.run.outcome ? <> · outcome {run.run.outcome.replace(/_/g, " ")}</> : null}
              </CardDescription>
            </div>
            {running ? (
              <Button variant="destructive" size="sm" disabled={cancelPending} onClick={() => setConfirmCancelOpen(true)}>
                {cancelPending ? "Canceling…" : "Cancel run"}
              </Button>
            ) : (
              <Button size="sm" onClick={onViewResults}>View results & report</Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2" aria-live="polite">
            {run.cases.map((caseRun) => (
              <li key={caseRun.id} className="rounded-md border px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  {caseRun.status === "running" ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-label="Running" />
                  ) : null}
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {caseRun.orderIndex + 1}. {caseRun.title}
                  </span>
                  {caseRun.outcome ? (
                    <OutcomeBadge outcome={caseRun.outcome} />
                  ) : (
                    <span className="text-xs text-muted-foreground">{caseRun.status}</span>
                  )}
                </div>
                {caseRun.status === "running" ? (
                  <ul className="mt-2 space-y-1 border-t pt-2 text-xs text-muted-foreground">
                    {caseRun.steps.map((step) => {
                      const action = (step.action ?? {}) as { instruction?: string };
                      return (
                        <li key={step.id} className="flex items-center gap-2">
                          <span className="w-5 text-right tabular-nums">{step.orderIndex + 1}.</span>
                          <span className="min-w-0 flex-1 truncate">{action.instruction ?? "(step)"}</span>
                          {step.outcome ? (
                            <OutcomeBadge outcome={step.outcome} className="scale-90" />
                          ) : step.status === "running" ? (
                            <span aria-hidden>…</span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
          {terminal ? null : (
            <p className="mt-3 text-xs text-muted-foreground">
              Progress refreshes automatically. You can leave this page — the run continues on the worker, and the report survives restarts.
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmCancelOpen} onOpenChange={setConfirmCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cancel this run?</DialogTitle>
            <DialogDescription>
              Active layer resources are stopped at the next safe checkpoint. Finished cases keep their results; the in-flight case is marked canceled and remaining cases stay not run.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancelOpen(false)}>
              Keep running
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmCancelOpen(false);
                void onCancelRun();
              }}
            >
              Cancel run
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
