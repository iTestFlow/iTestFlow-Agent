"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { patchJson, postJson } from "@/components/workflow/post-json";
import { projectWarning, useActiveProject } from "@/components/workflow/test-intelligence-shared";
import type { RunDetailDto } from "@/modules/test-execution/report-assembler";

import { ResultsStep, type CandidatePublishState } from "../../components/results-step";
import { saveActiveRunId, saveDraft, type DraftCase } from "../../lib/draft-storage";
import { runPollDelay } from "../../lib/run-polling";
import { isTerminalRunStatusValue } from "../../lib/stepper-gating";

export function RunDetailClient({ runId }: { runId: string }) {
  const scope = useActiveProject();
  const router = useRouter();
  const [detail, setDetail] = useState<RunDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<CandidatePublishState>({});
  const failures = useRef(0);
  const startedAt = useRef(Date.now());

  const scopeQuery = scope
    ? new URLSearchParams(
        Object.entries(scope).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1]),
      ).toString()
    : "";

  const fetchDetail = useCallback(async () => {
    if (!scopeQuery) return null;
    try {
      const response = await fetch(`/api/test-execution/runs/${runId}?${scopeQuery}`, { cache: "no-store" });
      if (!response.ok) {
        setError(response.status === 404 ? "This run was not found in the selected project." : "The report could not be loaded.");
        return null;
      }
      failures.current = 0;
      setError(null);
      const body: RunDetailDto = await response.json();
      setDetail(body);
      return body;
    } catch {
      failures.current += 1;
      return null;
    }
  }, [runId, scopeQuery]);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (disposed) return;
      const body = await fetchDetail();
      if (disposed) return;
      if (body && isTerminalRunStatusValue(body.run.status)) return;
      timer = setTimeout(() => void tick(), runPollDelay(Date.now() - startedAt.current, failures.current));
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchDetail]);

  const updateCandidate = async (candidateId: string, patch: { status?: string; draft?: Record<string, unknown> }) => {
    if (!scope) return;
    try {
      await patchJson(`/api/test-execution/defect-candidates/${candidateId}`, { scope, ...patch });
      await fetchDetail();
    } catch (updateError) {
      toast.error(updateError instanceof Error ? updateError.message : "The candidate could not be updated.");
    }
  };

  const publishCandidate = async (candidateId: string) => {
    if (!scope) return;
    setPublishState((previous) => ({ ...previous, [candidateId]: { pending: true, error: null, azureBugId: null } }));
    try {
      const body = await postJson<{ azureBugId: string }>(
        `/api/test-execution/defect-candidates/${candidateId}/publish`,
        { scope },
      );
      setPublishState((previous) => ({
        ...previous,
        [candidateId]: { pending: false, error: null, azureBugId: body.azureBugId },
      }));
      toast.success(`Bug #${body.azureBugId} created in Azure DevOps.`);
      await fetchDetail();
    } catch (publishError) {
      setPublishState((previous) => ({
        ...previous,
        [candidateId]: {
          pending: false,
          error: publishError instanceof Error ? publishError.message : "Publish failed.",
          azureBugId: null,
        },
      }));
    }
  };

  const stageRerun = (cases: DraftCase[], step: "scope" | "review") => {
    if (!scope || !detail) return;
    saveDraft(scope.projectId, {
      storyWorkItemId: detail.run.storyWorkItemId ?? "",
      storyTitle: detail.run.storyTitle ?? "",
      environmentProfileId: detail.run.environmentProfileId,
      cases,
    });
    // An old local active-run marker must not override the staged landing.
    saveActiveRunId(scope.projectId, null);
    if (detail.run.environmentProfileId === null) {
      toast.warning("This run used a one-time environment â€” reconfigure it before executing.");
    }
    router.push(`/test-execution?step=${step}`);
  };

  if (!scope) return <div className="content-stack">{projectWarning(scope)}</div>;

  return (
    <div className="content-stack">
      <div>
        <Button asChild variant="ghost" size="sm">
          <a href="/test-execution">
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden /> Back to Test Execution
          </a>
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Report unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : detail ? (
        <ResultsStep
          detail={detail}
          artifactUrl={(artifactId) => `/api/test-execution/runs/${runId}/artifacts/${artifactId}?${scopeQuery}`}
          onRerunCases={isTerminalRunStatusValue(detail.run.status) ? (cases) => stageRerun(cases, "review") : null}
          onEditCases={isTerminalRunStatusValue(detail.run.status) ? (cases) => stageRerun(cases, "scope") : null}
          onUpdateCandidate={updateCandidate}
          onPublishCandidate={publishCandidate}
          publishState={publishState}
        />
      ) : (
        <div className="space-y-3" aria-label="Loading report">
          <div className="h-24 animate-pulse rounded-md bg-muted" />
          <div className="h-64 animate-pulse rounded-md bg-muted" />
        </div>
      )}
    </div>
  );
}
