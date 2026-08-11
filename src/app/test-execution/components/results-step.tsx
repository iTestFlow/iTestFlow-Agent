"use client";

import { useEffect, useMemo, useState } from "react";
import { Bug, Loader2, RotateCcw, Send } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

type StepActionJson = { instruction?: string; expectedResult?: string; layerHint?: "auto" | "ui" | "api" | "db" | "mixed" };
type StepObservationJson = {
  actionsTaken?: { description: string; result: string; detail?: string; layer?: string }[];
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
  const [lightbox, setLightbox] = useState<{ id: string; fileName: string; kind: "screenshot" | "console_log" } | null>(null);

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
            layerHint: action.layerHint ?? "auto",
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
                Approved by {detail.run.approvedByName ?? "a removed user"} · {detail.cases.length} case(s)
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
                    const layerActions = step.actions ?? [];
                    return (
                      <li key={step.id} className="rounded bg-muted/40 px-2 py-1.5 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                            {step.orderIndex + 1}.
                          </span>
                          <span className="min-w-0 flex-1 truncate" title={action.instruction}>
                            {action.instruction ?? "(step)"}
                          </span>
                          {action.layerHint && action.layerHint !== "auto" ? (
                            <Badge variant="outline" className="shrink-0 uppercase">{action.layerHint}</Badge>
                          ) : null}
                          {otherArtifacts.map((artifact) => (
                            <button
                              key={artifact.id}
                              type="button"
                              className="text-xs text-muted-foreground underline hover:text-foreground"
                              onClick={() =>
                                setLightbox({ id: artifact.id, fileName: artifact.fileName, kind: "console_log" })
                              }
                            >
                              console log
                            </button>
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
                        {layerActions.length > 0 ? (
                          <details className="ml-7 mt-1">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              Layer actions ({layerActions.length})
                            </summary>
                            <ol className="mt-1 space-y-1 text-xs text-muted-foreground">
                              {layerActions.map((record) => (
                                <li key={record.id} className="rounded border bg-background px-2 py-1.5">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <Badge variant="outline" className="uppercase">{record.layer || "action"}</Badge>
                                    <span className="font-medium text-foreground">{humanizeActionType(record.actionType)}</span>
                                    <span>· {record.status.replace(/_/g, " ")}</span>
                                    {record.finishedAt ? <span>· {formatActionDuration(record.startedAt, record.finishedAt)}</span> : null}
                                  </div>
                                  {summarizeActionEvidence(record.request, record.observation) ? (
                                    <p className="mt-0.5 break-words font-mono text-[11px]">
                                      {summarizeActionEvidence(record.request, record.observation)}
                                    </p>
                                  ) : null}
                                  {record.errorMessage ? <p className="mt-0.5 text-destructive">{record.errorMessage}</p> : null}
                                </li>
                              ))}
                            </ol>
                          </details>
                        ) : observation.actionsTaken && observation.actionsTaken.length > 0 ? (
                          <details className="ml-7 mt-1">
                            <summary className="cursor-pointer text-xs text-muted-foreground">
                              Browser actions ({observation.actionsTaken.length})
                            </summary>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                              {observation.actionsTaken.map((record, recordIndex) => (
                                <li key={recordIndex} className="flex flex-wrap items-center gap-1">
                                  {record.layer ? <Badge variant="outline" className="uppercase">{record.layer}</Badge> : null}
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
                                onClick={() =>
                                  setLightbox({ id: artifact.id, fileName: artifact.fileName, kind: "screenshot" })
                                }
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
                          onClick={() =>
                            setLightbox({ id: artifact.id, fileName: artifact.fileName, kind: "screenshot" })
                          }
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
                        <button
                          key={artifact.id}
                          type="button"
                          className="flex items-center gap-1 rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
                          onClick={() =>
                            setLightbox({ id: artifact.id, fileName: artifact.fileName, kind: "console_log" })
                          }
                        >
                          {artifact.fileName}
                        </button>
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
        <DialogContent className="sm:max-w-[min(92vw,72rem)]">
          <DialogHeader>
            <DialogTitle>{lightbox?.fileName}</DialogTitle>
          </DialogHeader>
          {lightbox?.kind === "screenshot" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={artifactUrl(lightbox.id)}
              alt={`Evidence screenshot: ${lightbox.fileName}`}
              className="max-h-[80vh] w-full rounded-md border bg-muted object-contain"
              loading="lazy"
            />
          ) : lightbox ? (
            <ArtifactTextViewer url={artifactUrl(lightbox.id)} fileName={lightbox.fileName} />
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

/** Fetches a text artifact (console log) and renders it scrollably in the dialog. */
function ArtifactTextViewer({ url, fileName }: { url: string; fileName: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    setText(null);
    setError(null);
    void fetch(url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`The log could not be loaded (${response.status}).`);
        return response.text();
      })
      .then((body) => {
        if (!disposed) setText(body);
      })
      .catch((fetchError) => {
        if (!disposed) setError(fetchError instanceof Error ? fetchError.message : "The log could not be loaded.");
      });
    return () => {
      disposed = true;
    };
  }, [url]);

  if (error) {
    return <p className="text-sm text-destructive" role="alert">{error}</p>;
  }
  if (text === null) {
    return <div className="h-40 animate-pulse rounded-md bg-muted" aria-label={`Loading ${fileName}`} />;
  }
  return (
    <div className="space-y-2">
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 font-mono text-xs">
        {text || "(the log is empty)"}
      </pre>
      <a href={url} download={fileName} className="text-xs text-muted-foreground underline hover:text-foreground">
        Download {fileName}
      </a>
    </div>
  );
}

export function humanizeActionType(value: string): string {
  return value.replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Action";
}

/** Render a compact allowlisted summary; never dump arbitrary response bodies or result rows. */
export function summarizeActionEvidence(request: unknown, observation: unknown): string {
  const parts: string[] = [];
  const req = asRecord(request);
  const result = asRecord(observation);
  const method = scalar(req?.method);
  const path = scalar(req?.path) || scalar(req?.url);
  const operation = scalar(req?.operationName) || scalar(req?.operation) || scalar(req?.catalogName);
  const statement = scalar(req?.statementName) || scalar(req?.queryName);
  if (method || path) parts.push([method?.toUpperCase(), path].filter(Boolean).join(" "));
  else if (operation || statement) parts.push(operation || statement || "");

  const status = scalar(result?.statusCode) || scalar(result?.status);
  const rowCount = scalar(result?.rowCount);
  const command = scalar(result?.command);
  const summary = scalar(result?.summary) || scalar(result?.actualResult) || scalar(result?.message);
  if (status) parts.push(`status ${status}`);
  if (command) parts.push(command);
  if (rowCount) parts.push(`${rowCount} row(s)`);
  if (summary) parts.push(summary.slice(0, 180));
  return parts.filter(Boolean).join(" · ");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scalar(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function formatActionDuration(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`;
}

function formatDuration(startedAt: string, finishedAt: string): string {
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
