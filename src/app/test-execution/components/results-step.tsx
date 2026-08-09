"use client";

import { useMemo, useState } from "react";
import { Bug, Loader2, RotateCcw, Send } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { RunDetailDto } from "@/modules/test-execution/report-assembler";

import type { DraftCase } from "../lib/draft-storage";
import { OutcomeBadge } from "./outcome-badge";

/**
 * Results & Report: outcome summary, per-case/per-step drilldown with the
 * agent's action transcript and expected-vs-actual evidence, screenshot
 * gallery, "Re-run failed cases", and the defect-candidate review with
 * explicit, idempotent publication.
 */

export type CandidatePublishState = Record<string, { pending: boolean; error: string | null; azureBugId: string | null }>;

type StepActionJson = { instruction?: string; expectedResult?: string };
type StepObservationJson = {
  actionsTaken?: { description: string; result: string; detail?: string }[];
  actualResult?: string;
  reason?: string;
  iterations?: number;
};

export function ResultsStep({
  detail,
  artifactUrl,
  onRerunCases,
  onUpdateCandidate,
  onPublishCandidate,
  publishState,
}: {
  detail: RunDetailDto;
  artifactUrl: (artifactId: string) => string;
  onRerunCases: ((cases: DraftCase[]) => void) | null;
  onUpdateCandidate: (candidateId: string, patch: { status?: string; draft?: Record<string, unknown> }) => Promise<void>;
  onPublishCandidate: (candidateId: string) => Promise<void>;
  publishState: CandidatePublishState;
}) {
  const [lightbox, setLightbox] = useState<{ id: string; fileName: string } | null>(null);

  const summary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const caseRun of detail.cases) {
      const outcome = caseRun.outcome ?? caseRun.status;
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    return counts;
  }, [detail.cases]);

  const failedCases = detail.cases.filter(
    (caseRun) => caseRun.outcome && caseRun.outcome !== "passed" && caseRun.outcome !== "skipped" && caseRun.outcome !== "not_run",
  );

  const rerunFailed = () => {
    if (!onRerunCases) return;
    const drafts: DraftCase[] = failedCases.map((caseRun) => ({
      title: caseRun.title,
      sourceKind: caseRun.sourceKind === "azure_test_case" ? "azure_test_case" : "manual",
      azureTestCaseId: null,
      plan: {
        schemaVersion: "v2-natural",
        steps: caseRun.steps.map((step) => {
          const action = (step.action ?? {}) as StepActionJson;
          return {
            instruction: action.instruction ?? "",
            expectedResult: action.expectedResult ?? "",
          };
        }),
      },
    }));
    onRerunCases(drafts);
  };

  const tokenUsage = (detail.run.summary as { tokenUsage?: { totalTokens?: number } } | null)?.tokenUsage;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                Run result <OutcomeBadge outcome={detail.run.outcome ?? detail.run.status} />
              </CardTitle>
              <CardDescription>
                {detail.run.storyWorkItemId ? <>Story #{detail.run.storyWorkItemId} · </> : null}
                Approved by {detail.run.approvedBy} · {detail.cases.length} case(s)
                {detail.run.startedAt && detail.run.finishedAt ? (
                  <> · duration {formatDuration(detail.run.startedAt, detail.run.finishedAt)}</>
                ) : null}
                {tokenUsage?.totalTokens ? <> · {tokenUsage.totalTokens.toLocaleString()} AI tokens</> : null}
              </CardDescription>
            </div>
            {onRerunCases && failedCases.length > 0 ? (
              <Button variant="outline" size="sm" onClick={rerunFailed}>
                <RotateCcw className="mr-1 h-4 w-4" aria-hidden /> Re-run failed cases ({failedCases.length})
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {[...summary.entries()].map(([outcome, count]) => (
              <div key={outcome} className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm">
                <OutcomeBadge outcome={outcome} />
                <span className="font-semibold tabular-nums">{count}</span>
              </div>
            ))}
          </div>
          {detail.run.errorMessage ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>Run error</AlertTitle>
              <AlertDescription>{detail.run.errorMessage}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Case results</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.cases.map((caseRun) => (
            <details key={caseRun.id} className="rounded-md border">
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {caseRun.orderIndex + 1}. {caseRun.title}
                </span>
                {caseRun.sourceKind === "azure_test_case" ? (
                  <span className="text-xs text-muted-foreground">Azure test case</span>
                ) : null}
                <OutcomeBadge outcome={caseRun.outcome ?? caseRun.status} />
              </summary>
              <div className="space-y-2 border-t px-3 py-2">
                {caseRun.errorMessage ? (
                  <p className="text-sm text-destructive">{caseRun.errorMessage}</p>
                ) : null}
                <ol className="space-y-1.5">
                  {caseRun.steps.map((step) => {
                    const action = (step.action ?? {}) as StepActionJson;
                    const observation = (step.observation ?? {}) as StepObservationJson;
                    const screenshots = step.artifacts.filter((artifact) => artifact.kind === "screenshot");
                    const otherArtifacts = step.artifacts.filter((artifact) => artifact.kind !== "screenshot");
                    return (
                      <li key={step.id} className="rounded bg-muted/40 px-2 py-1.5 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                            {step.orderIndex + 1}.
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={action.instruction}>
                            {action.instruction ?? "(step)"}
                          </span>
                          {otherArtifacts.map((artifact) => (
                            <a
                              key={artifact.id}
                              href={artifactUrl(artifact.id)}
                              className="text-xs text-muted-foreground underline hover:text-foreground"
                            >
                              console log
                            </a>
                          ))}
                          <OutcomeBadge outcome={step.outcome ?? step.status} className="shrink-0 scale-90" />
                        </div>
                        {action.expectedResult || observation.actualResult ? (
                          <p className="ml-7 mt-1 text-xs text-muted-foreground">
                            {action.expectedResult ? <>expected: {action.expectedResult}</> : null}
                            {action.expectedResult && observation.actualResult ? " · " : null}
                            {observation.actualResult ? <>actual: {observation.actualResult}</> : null}
                          </p>
                        ) : null}
                        {observation.reason ? (
                          <p className="ml-7 mt-1 text-xs text-muted-foreground">{observation.reason}</p>
                        ) : null}
                        {observation.actionsTaken && observation.actionsTaken.length > 0 ? (
                          <details className="ml-7 mt-1">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              AI actions ({observation.actionsTaken.length})
                            </summary>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {observation.actionsTaken.map((record, recordIndex) => (
                                <li key={recordIndex}>
                                  {record.description} → {record.result}
                                  {record.detail ? ` (${record.detail})` : ""}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                        {step.errorMessage && !observation.reason ? (
                          <p className="ml-7 mt-1 text-xs text-destructive">{step.errorMessage}</p>
                        ) : null}
                        {screenshots.length > 0 ? (
                          <div className="ml-7 mt-2 flex flex-wrap gap-2">
                            {screenshots.map((artifact) => (
                              <button
                                key={artifact.id}
                                type="button"
                                className="group overflow-hidden rounded-md border transition-shadow hover:shadow-md"
                                aria-label={`Open screenshot for step ${step.orderIndex + 1}: ${artifact.fileName}`}
                                onClick={() => setLightbox({ id: artifact.id, fileName: artifact.fileName })}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={artifactUrl(artifact.id)}
                                  alt={`Screenshot evidence: ${artifact.fileName}`}
                                  className="h-24 w-40 bg-muted object-cover object-top"
                                  style={{ aspectRatio: "16 / 10" }}
                                  loading="lazy"
                                />
                                <span className="block truncate px-1.5 py-0.5 text-left text-[10px] text-muted-foreground">
                                  {artifact.fileName}
                                </span>
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                {caseRun.artifacts.length > 0 ? (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {caseRun.artifacts.map((artifact) =>
                      artifact.kind === "screenshot" ? (
                        <button
                          key={artifact.id}
                          type="button"
                          className="group overflow-hidden rounded-md border transition-shadow hover:shadow-md"
                          aria-label={`Open case screenshot: ${artifact.fileName}`}
                          onClick={() => setLightbox({ id: artifact.id, fileName: artifact.fileName })}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={artifactUrl(artifact.id)}
                            alt={`Screenshot evidence: ${artifact.fileName}`}
                            className="h-24 w-40 bg-muted object-cover object-top"
                            style={{ aspectRatio: "16 / 10" }}
                            loading="lazy"
                          />
                          <span className="block truncate px-1.5 py-0.5 text-left text-[10px] text-muted-foreground">
                            {artifact.fileName}
                          </span>
                        </button>
                      ) : (
                        <a
                          key={artifact.id}
                          href={artifactUrl(artifact.id)}
                          className="flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                        >
                          {artifact.fileName}
                        </a>
                      ),
                    )}
                  </div>
                ) : null}
              </div>
            </details>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bug className="h-4 w-4" aria-hidden /> Defect candidates
          </CardTitle>
          <CardDescription>
            Failures become editable candidates — nothing is published to Azure DevOps without your explicit action, and each candidate can be published at most once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.defectCandidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No defect candidates{failedCases.length > 0 ? " were generated for this run" : " — every executed case passed"}.
            </p>
          ) : (
            detail.defectCandidates.map((candidate) => (
              <DefectCandidateCard
                key={candidate.id}
                candidate={candidate}
                state={publishState[candidate.id] ?? { pending: false, error: null, azureBugId: null }}
                onUpdate={onUpdateCandidate}
                onPublish={onPublishCandidate}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={lightbox !== null} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{lightbox?.fileName}</DialogTitle>
          </DialogHeader>
          {lightbox ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={artifactUrl(lightbox.id)}
              alt={`Evidence screenshot: ${lightbox.fileName}`}
              className="max-h-[70vh] w-full rounded-md border object-contain"
              style={{ aspectRatio: "16 / 9" }}
              loading="lazy"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DefectCandidateCard({
  candidate,
  state,
  onUpdate,
  onPublish,
}: {
  candidate: RunDetailDto["defectCandidates"][number];
  state: { pending: boolean; error: string | null; azureBugId: string | null };
  onUpdate: (candidateId: string, patch: { status?: string; draft?: Record<string, unknown> }) => Promise<void>;
  onPublish: (candidateId: string) => Promise<void>;
}) {
  const draft = (candidate.draft ?? {}) as { title?: string; description?: string };
  const [title, setTitle] = useState(draft.title ?? "");
  const [description, setDescription] = useState(draft.description ?? "");
  const published = candidate.status === "published" || state.azureBugId !== null;
  const dismissed = candidate.status === "dismissed";

  return (
    <div className={`space-y-2 rounded-md border p-3 ${dismissed ? "opacity-60" : ""}`}>
      <div className="space-y-1.5">
        <Label htmlFor={`cand-title-${candidate.id}`}>Bug title</Label>
        <Input
          id={`cand-title-${candidate.id}`}
          value={title}
          disabled={published || dismissed}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => void onUpdate(candidate.id, { draft: { ...draft, title } })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`cand-desc-${candidate.id}`}>Description & reproduction</Label>
        <Textarea
          id={`cand-desc-${candidate.id}`}
          rows={4}
          value={description}
          disabled={published || dismissed}
          onChange={(event) => setDescription(event.target.value)}
          onBlur={() => void onUpdate(candidate.id, { draft: { ...draft, title, description } })}
        />
      </div>
      {state.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error} — you can retry; a failed attempt never creates a duplicate bug.
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {published
            ? `Published to Azure DevOps${state.azureBugId ? ` as bug #${state.azureBugId}` : ""}.`
            : dismissed
              ? "Dismissed."
              : `Status: ${candidate.status}`}
        </span>
        <span className="flex gap-2">
          {!published && !dismissed ? (
            <Button variant="ghost" size="sm" onClick={() => void onUpdate(candidate.id, { status: "dismissed" })}>
              Dismiss
            </Button>
          ) : null}
          {dismissed ? (
            <Button variant="ghost" size="sm" onClick={() => void onUpdate(candidate.id, { status: "proposed" })}>
              Restore
            </Button>
          ) : null}
          {!published && !dismissed ? (
            <Button size="sm" disabled={state.pending || !title.trim()} onClick={() => void onPublish(candidate.id)}>
              {state.pending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" aria-hidden /> : <Send className="mr-1 h-3.5 w-3.5" aria-hidden />}
              Publish to Azure DevOps
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function formatDuration(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
