"use client";

import { Loader2, Play, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { StatusChip } from "@/components/qa/status-chip";
import { SectionCard } from "@/components/workflow/test-intelligence-shared";
import { StickyActionBar } from "@/components/workflow/sticky-action-bar";
import { SCREENSHOT_POLICY_LABELS } from "@/modules/test-execution/screenshot-policy";
import type { ExecutionDraft } from "../lib/execution-draft";
import { runStatusLabel, runStatusTone, type RunDetail } from "../lib/run-types";

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[200px_1fr] sm:gap-4">
      <dt className="text-sm font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{value}</dd>
    </div>
  );
}

/**
 * Step 3 — a pre-flight summary with one Approve button. Once the run is
 * queued the same step shows live progress; the run keeps going on the
 * worker even if the page is closed.
 */
export function ReviewStep({
  draft,
  issues,
  liveRun,
  creating,
  onExecute,
  onCancelRun,
}: {
  draft: ExecutionDraft;
  issues: string[];
  liveRun: RunDetail | null;
  creating: boolean;
  onExecute: () => void;
  onCancelRun: () => void;
}) {
  const totalSteps = draft.cases.reduce((sum, testCase) => sum + testCase.steps.length, 0);
  const publishable = draft.cases.filter((testCase) => testCase.azureTestPointId).length;
  const secretCount = draft.setup.testData.filter((entry) => entry.isSecret).length;
  const dataCount = draft.setup.testData.filter((entry) => entry.title.trim()).length;

  if (liveRun) {
    const percent = liveRun.totalCases ? Math.round((liveRun.completedCases / liveRun.totalCases) * 100) : 0;
    return (
      <SectionCard title="Execution in progress" description="You can leave this page — the run continues on the worker and the results are kept.">
        <div className="space-y-4 p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-3">
            <StatusChip tone={runStatusTone(liveRun.status)}>{runStatusLabel(liveRun.status)}</StatusChip>
            <span className="text-sm text-muted-foreground">
              {liveRun.completedCases} of {liveRun.totalCases} test case{liveRun.totalCases === 1 ? "" : "s"} finished
            </span>
          </div>
          <Progress value={percent} aria-label="Run progress" />
          <ul className="space-y-2">
            {liveRun.cases.map((testCase) => (
              <li key={testCase.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <span className="min-w-0 truncate text-sm font-medium">{testCase.title}</span>
                <StatusChip tone={runStatusTone(testCase.status)}>{runStatusLabel(testCase.status)}</StatusChip>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <ConfirmationDialog
              trigger={<Button type="button" variant="destructive"><Square className="size-4" aria-hidden="true" />Cancel run</Button>}
              title="Cancel this run?"
              description="The current step finishes and everything else is marked cancelled. Results so far are kept."
              confirmLabel="Cancel run"
              cancelLabel="Keep running"
              onConfirm={onCancelRun}
            />
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="content-stack">
      <SectionCard title="Review the plan" description="Check the summary, then approve to start the execution.">
        <dl className="divide-y divide-border p-4">
          <SummaryRow label="Base URL" value={draft.setup.baseUrl.trim() || <span className="text-muted-foreground">Not set</span>} />
          <SummaryRow label="Screenshots" value={SCREENSHOT_POLICY_LABELS[draft.setup.screenshotPolicy]} />
          <SummaryRow
            label="Test data"
            value={dataCount ? `${dataCount} value${dataCount === 1 ? "" : "s"}${secretCount ? ` (${secretCount} private)` : ""}` : "None"}
          />
          <SummaryRow label="Instructions for the AI" value={draft.setup.executionNotes.trim() ? "Provided" : "None"} />
          <SummaryRow label="Test cases" value={`${draft.cases.length} case${draft.cases.length === 1 ? "" : "s"} · ${totalSteps} step${totalSteps === 1 ? "" : "s"}`} />
          <SummaryRow
            label="Azure outcomes"
            value={publishable
              ? `${publishable} of ${draft.cases.length} case${draft.cases.length === 1 ? "" : "s"} can publish results back to the Test Plan after the run.`
              : "No cases came from a Test Plan, so results stay in iTestFlow."}
          />
          <SummaryRow label="Order" value="Cases run one after another in a fresh browser each." />
        </dl>
      </SectionCard>

      {issues.length ? (
        <Callout tone="warning" title="The plan cannot run yet" role="alert">
          <ul className="list-disc space-y-1 pl-4">
            {issues.map((issue) => <li key={issue}>{issue}</li>)}
          </ul>
        </Callout>
      ) : null}

      <StickyActionBar
        title="Ready to execute?"
        description={draft.cases.length
          ? `Runs ${draft.cases.length} test case${draft.cases.length === 1 ? "" : "s"} against ${draft.setup.baseUrl.trim() || "the Base URL"}.`
          : "Add test cases before executing."}
        actions={
          <Button type="button" disabled={creating || issues.length > 0 || !draft.cases.length} onClick={onExecute}>
            {creating ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
            Approve &amp; Execute
          </Button>
        }
      />
    </div>
  );
}
