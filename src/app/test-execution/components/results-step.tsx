"use client";

import { Loader2, Pencil, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { StatusChip } from "@/components/qa/status-chip";
import { SectionCard } from "@/components/workflow/test-intelligence-shared";
import { StickyActionBar } from "@/components/workflow/sticky-action-bar";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { runStatusLabel, runStatusTone, type RunArtifact, type RunDetail } from "../lib/run-types";
import { ExecutionStepRow } from "./execution-step-row";
import { ScreenshotPreviewDialog } from "./screenshot-preview-dialog";

function artifactHref(scope: ActiveProjectScope, artifactId: string): string {
  const query = new URLSearchParams(
    Object.entries(scope).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return `/api/test-execution/playwright/artifacts/${artifactId}?${query}`;
}

function StepArtifacts({ scope, artifacts }: { scope: ActiveProjectScope; artifacts: RunArtifact[] }) {
  if (!artifacts.length) return null;
  const screenshots = artifacts.filter((artifact) => artifact.kind === "screenshot");
  const others = artifacts.filter((artifact) => artifact.kind !== "screenshot");
  return (
    <div className="mt-2 space-y-2">
      {screenshots.length ? (
        <div className="flex flex-wrap gap-2">
          {screenshots.map((artifact) => (
            <ScreenshotPreviewDialog
              key={artifact.id}
              href={artifactHref(scope, artifact.id)}
              trigger={
                <button type="button" className="focus-ring block cursor-zoom-in overflow-hidden rounded-md border border-border">
                  {/* eslint-disable-next-line @next/next/no-img-element -- streamed evidence bytes, not an optimizable asset */}
                  <img
                    src={artifactHref(scope, artifact.id)}
                    alt="Step screenshot evidence — open preview"
                    loading="lazy"
                    className="h-24 w-auto max-w-40 object-cover"
                  />
                </button>
              }
            />
          ))}
        </div>
      ) : null}
      {others.length ? (
        <div className="flex flex-wrap gap-2">
          {others.map((artifact) => (
            <Button key={artifact.id} variant="outline" size="xs" asChild>
              <a href={artifactHref(scope, artifact.id)} target="_blank" rel="noreferrer">
                {artifact.kind} · {Math.ceil(artifact.byteSize / 1024)} KiB
              </a>
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Step 4 — outcomes per case and step with inline evidence, plus explicit
 * publication of Test-Point-backed outcomes to Azure DevOps and a rerun
 * entry point that stages everything back into the editor.
 */
export function ResultsStep({
  scope,
  run,
  onRerun,
  onPublish,
  publishBusy,
}: {
  scope: ActiveProjectScope;
  run: RunDetail;
  onRerun: () => void;
  onPublish: (retryFailed: boolean) => void;
  publishBusy: boolean;
}) {
  const publishableCount = run.cases.filter((testCase) => testCase.azureTestPointId).length;
  const publication = run.publication ?? null;
  const canRetry = publication ? ["partial", "failed"].includes(publication.status) : false;
  const artifactsByStep = new Map<string, RunArtifact[]>();
  for (const artifact of run.artifacts) {
    if (!artifact.stepId) continue;
    artifactsByStep.set(artifact.stepId, [...(artifactsByStep.get(artifact.stepId) ?? []), artifact]);
  }

  return (
    <div className="content-stack">
      <SectionCard
        title="Run results"
        description={<span className="font-mono text-xs">{run.id}</span>}
        action={<StatusChip tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusChip>}
      >
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted-foreground">
            {run.completedCases} of {run.totalCases} case{run.totalCases === 1 ? "" : "s"} finished · started {new Date(run.createdAt).toLocaleString()}
          </p>
          {run.errorMessage ? <Callout tone="error" title="Run error" role="alert">{run.errorMessage}</Callout> : null}
        </div>
      </SectionCard>

      <SectionCard title="Test cases">
        <div className="space-y-3 p-4">
          {run.cases.map((testCase) => (
            <div key={testCase.id} className="rounded-lg border border-border">
              <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
                {testCase.azureTestCaseId ? <span className="font-mono text-xs text-primary">#{testCase.azureTestCaseId}</span> : null}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{testCase.title}</span>
                {!testCase.azureTestPointId ? (
                  <Badge variant="ghost" title="Only cases imported from a Test Plan carry a test point. This case's result stays in iTestFlow.">
                    Not publishable
                  </Badge>
                ) : null}
                <StatusChip tone={runStatusTone(testCase.status)}>{runStatusLabel(testCase.status)}</StatusChip>
              </div>
              <div className="space-y-2 p-3">
                {testCase.errorMessage ? <p className="text-sm text-destructive">{testCase.errorMessage}</p> : null}
                {testCase.steps.map((step) => (
                  <ExecutionStepRow key={step.id} step={step}>
                    <StepArtifacts scope={scope} artifacts={artifactsByStep.get(step.id) ?? []} />
                  </ExecutionStepRow>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Publish to Azure DevOps"
        description="Outcomes update the Test Points of cases imported from a Test Plan. Nothing publishes without your confirmation."
      >
        <div className="space-y-3 p-4">
          {publishableCount ? (
            <p className="text-sm">
              {publishableCount} of {run.cases.length} case{run.cases.length === 1 ? "" : "s"} can be published.
            </p>
          ) : (
            <Callout tone="info">
              None of this run&apos;s cases carry an Azure Test Point, so there is nothing to publish. Only cases imported from a Test Plan can update their outcome in Azure DevOps.
            </Callout>
          )}
          {publication?.status === "completed" ? (
            <Callout tone="success" role="status">Published {publication.published} of {publication.total} outcome{publication.total === 1 ? "" : "s"} to Azure DevOps.</Callout>
          ) : null}
          {publication && publication.status !== "completed" ? (
            <Callout tone={publication.status === "running" ? "info" : "warning"} role="status">
              {publication.status === "running"
                ? "A publication is currently in progress."
                : `Publication ${publication.status === "partial" ? "partially succeeded" : "failed"} — ${publication.published} of ${publication.total} outcomes made it to Azure DevOps.`}
            </Callout>
          ) : null}
          {publishableCount ? (
            <div className="flex flex-wrap gap-2">
              <ConfirmationDialog
                trigger={
                  <Button type="button" disabled={publishBusy}>
                    {publishBusy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                    Publish results to Azure DevOps
                  </Button>
                }
                title="Publish results to Azure DevOps?"
                description={`This updates the outcome of ${publishableCount} Test Point${publishableCount === 1 ? "" : "s"} (passed, failed, blocked…) in the source Test Plan. Confirm that you reviewed the results.`}
                confirmLabel="Publish"
                onConfirm={() => onPublish(false)}
              />
              {canRetry ? (
                <Button type="button" variant="outline" disabled={publishBusy} onClick={() => onPublish(true)}>
                  Retry failed publication
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </SectionCard>

      <StickyActionBar
        title="Run it again?"
        description="Loads this run's setup and test cases back into the editor so you can adjust anything before executing."
        actions={
          <Button type="button" variant="outline" onClick={onRerun}>
            <Pencil className="size-4" aria-hidden="true" />
            Edit &amp; rerun
          </Button>
        }
      />
    </div>
  );
}
