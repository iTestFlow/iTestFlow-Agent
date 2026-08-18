"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import { postJson } from "@/components/workflow/post-json";
import { projectWarning, useActiveProject } from "@/components/workflow/test-intelligence-shared";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { caughtErrorMessage } from "@/shared/lib/api-error-message";
import {
  applyProfileToDraft,
  createEmptyDraft,
  draftFromRunDetail,
  draftHasContent,
  draftIssues,
  isValidHttpUrl,
  mergeImportedCases,
  testDataIssues,
  viewportIssues,
  type DraftCase,
  type DraftSetup,
  type ExecutionDraft,
  type ImportedCase,
} from "./lib/execution-draft";
import { clearDraft, loadDraft, saveDraft } from "./lib/draft-storage";
import { draftToRunRequest, setupToProfileRequest } from "./lib/run-payload";
import { EXECUTION_STEPS, deriveStepperState, type ExecutionStepId } from "./lib/stepper-gating";
import { isLiveRunStatus, type ExecutionProfileView, type RunDetail, type RunSummary } from "./lib/run-types";
import { SetupStep } from "./components/setup-step";
import { CaseImportPanel } from "./components/case-import-panel";
import { WorkingSetEditor } from "./components/working-set-editor";
import { ReviewStep } from "./components/review-step";
import { ResultsStep } from "./components/results-step";
import { RunHistoryCard } from "./components/run-history-card";
import { StepNav } from "./components/step-nav";

const RUN_POLL_MS = 1000;

export function TestExecutionClient() {
  const scope = useActiveProject();
  const projectId = scope?.projectId ?? null;

  const [providerId, setProviderId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExecutionDraft>(createEmptyDraft);
  const [activeStep, setActiveStep] = useState<ExecutionStepId>("setup");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [liveRun, setLiveRun] = useState<RunDetail | null>(null);
  const [viewedRun, setViewedRun] = useState<RunDetail | null>(null);
  const [profiles, setProfiles] = useState<ExecutionProfileView[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [rerunBusy, setRerunBusy] = useState(false);
  const [pendingRerunId, setPendingRerunId] = useState<string | null>(null);

  const bootedProjectRef = useRef<string | null>(null);

  const isJira = providerId === "jira-cloud";
  const issues = useMemo(() => [
    ...(isJira ? ["Test execution currently requires an Azure DevOps workspace."] : []),
    ...draftIssues(draft),
  ], [draft, isJira]);

  // A typed private value is the only draft content that does NOT survive a
  // refresh (drafts persist secret-free), so it is what the guard protects.
  const typedSecretValues = draft.setup.testData.some((entry) => entry.isSecret && entry.value.length > 0);
  useUnsavedChangesGuard({ dirty: typedSecretValues, busy: creating });

  useEffect(() => {
    void fetch("/api/auth/session", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: { workspace?: { providerId?: string } | null }) => setProviderId(data.workspace?.providerId ?? "azure-devops"))
      .catch(() => setProviderId("azure-devops"));
  }, []);

  const fetchRunDetail = useCallback(async (runId: string): Promise<RunDetail | null> => {
    if (!scope) return null;
    try {
      const data = await postJson<{ run: RunDetail }>(`/api/test-execution/playwright/runs/${runId}`, { scope });
      return data.run;
    } catch {
      return null;
    }
  }, [scope]);

  const loadHistory = useCallback(async () => {
    if (!scope) return;
    setHistoryLoading(true);
    try {
      const data = await postJson<{ runs: RunSummary[] }>("/api/test-execution/playwright/history", { scope });
      setRuns(data.runs);
      const live = data.runs.find((run) => isLiveRunStatus(run.status));
      if (live) {
        const detail = await fetchRunDetail(live.id);
        if (detail && isLiveRunStatus(detail.status)) {
          setLiveRun(detail);
          setActiveStep("review");
        }
      }
    } catch (error) {
      toast.error(caughtErrorMessage(error, "Execution history could not be loaded."));
    } finally {
      setHistoryLoading(false);
    }
  }, [scope, fetchRunDetail]);

  const loadProfiles = useCallback(async () => {
    if (!scope) return;
    setProfilesLoading(true);
    try {
      const data = await postJson<{ profiles: ExecutionProfileView[] }>("/api/test-execution/playwright/profiles/list", { scope });
      setProfiles(data.profiles);
    } catch {
      // Profiles are a convenience; the setup form works without them.
    } finally {
      setProfilesLoading(false);
    }
  }, [scope]);

  // Boot / project switch: restore the per-project draft, then load history + profiles.
  useEffect(() => {
    if (!projectId || bootedProjectRef.current === projectId) return;
    bootedProjectRef.current = projectId;
    setDraft(loadDraft(projectId) ?? createEmptyDraft());
    setActiveStep("setup");
    setLiveRun(null);
    setViewedRun(null);
    setRuns([]);
    void loadHistory();
    void loadProfiles();
  }, [projectId, loadHistory, loadProfiles]);

  // Secret-free draft autosave, per project.
  useEffect(() => {
    if (!projectId || bootedProjectRef.current !== projectId) return;
    saveDraft(projectId, draft);
  }, [projectId, draft]);

  // Live-run polling: full detail every second until the run turns terminal.
  // Guarded against overlapping and stale responses — a slow "running" snapshot
  // must never resurrect a run that a later response already finished.
  const liveRunId = liveRun?.id ?? null;
  useEffect(() => {
    if (!scope || !liveRunId) return;
    let cancelled = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void fetchRunDetail(liveRunId).then((detail) => {
        inFlight = false;
        if (cancelled || !detail || detail.id !== liveRunId) return;
        setRuns((current) => [
          detail,
          ...current.filter((run) => run.id !== detail.id),
        ]);
        if (isLiveRunStatus(detail.status)) {
          setLiveRun(detail);
          return;
        }
        cancelled = true;
        setLiveRun(null);
        setViewedRun(detail);
        setActiveStep("results");
        toast.info(`Execution finished: ${detail.status}.`);
      });
    }, RUN_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scope, liveRunId, fetchRunDetail]);

  const stepper = deriveStepperState({ draft, liveRunActive: Boolean(liveRun), hasViewedRun: Boolean(viewedRun) });

  function setSetup(setup: DraftSetup) {
    setDraft((current) => ({ ...current, setup }));
  }

  function setCases(cases: DraftCase[]) {
    setDraft((current) => ({ ...current, cases }));
  }

  function addImportedCases(imported: ImportedCase[], provenance?: { planId: number; suiteId: number }) {
    setDraft((current) => ({
      ...current,
      cases: mergeImportedCases(current.cases, imported),
      provenance: provenance ?? current.provenance,
    }));
  }

  async function execute() {
    if (!scope || creating) return;
    setCreating(true);
    try {
      const queued = await postJson<{ runId: string }>("/api/test-execution/playwright/runs", draftToRunRequest(draft, scope));
      toast.success("Execution queued.");
      if (projectId) clearDraft(projectId);
      const detail = await fetchRunDetail(queued.runId);
      setLiveRun(detail ?? {
        id: queued.runId, name: draft.setup.runName.trim() || null, status: "queued",
        totalCases: draft.cases.length, completedCases: 0,
        createdAt: new Date().toISOString(), azurePlanId: null, azureSuiteId: null,
        baseUrl: draft.setup.baseUrl, executionNotes: null, screenshotPolicy: draft.setup.screenshotPolicy,
        headless: draft.setup.headless,
        viewportWidth: Number(draft.setup.viewportWidth) || 1920, viewportHeight: Number(draft.setup.viewportHeight) || 1080,
        cases: [], artifacts: [],
      });
      setActiveStep("review");
      void loadHistory();
    } catch (error) {
      toast.error(caughtErrorMessage(error, "Execution could not be queued."));
    } finally {
      setCreating(false);
    }
  }

  async function cancelRun() {
    if (!scope || !liveRunId) return;
    try {
      await postJson(`/api/test-execution/playwright/runs/${liveRunId}/cancel`, { scope });
      toast.success("Cancellation requested — the current step finishes first.");
    } catch (error) {
      toast.error(caughtErrorMessage(error, "The run could not be cancelled."));
    }
  }

  async function publish(retryFailed: boolean) {
    if (!scope || !viewedRun) return;
    setPublishBusy(true);
    try {
      const result = await postJson<{ status: "completed" | "partial" | "failed"; published: number; total: number }>(
        `/api/test-execution/playwright/runs/${viewedRun.id}/publish`,
        { scope, confirmedReviewed: true, retryFailed },
      );
      if (result.status === "completed") {
        toast.success(`Published ${result.published} of ${result.total} outcome${result.total === 1 ? "" : "s"} to Azure DevOps.`);
      } else {
        toast.warning(`Only ${result.published} of ${result.total} outcome${result.total === 1 ? "" : "s"} reached Azure DevOps — use "Retry failed publication" below.`);
      }
    } catch (error) {
      toast.error(caughtErrorMessage(error, "Results could not be published."));
    } finally {
      const refreshed = await fetchRunDetail(viewedRun.id);
      if (refreshed) setViewedRun(refreshed);
      setPublishBusy(false);
    }
  }

  async function viewRun(runId: string) {
    if (liveRunId) {
      toast.info("The current run is still in progress — results open when it finishes.");
      return;
    }
    const detail = await fetchRunDetail(runId);
    if (!detail) {
      toast.error("The run's results could not be loaded.");
      return;
    }
    setViewedRun(detail);
    setActiveStep("results");
  }

  /** Rerun entry point: confirm first whenever it would replace authored work. */
  function requestRerun(runId: string) {
    if (draftHasContent(draft)) {
      setPendingRerunId(runId);
      return;
    }
    void stageRerun(runId);
  }

  async function stageRerun(runId: string) {
    setRerunBusy(true);
    try {
      const detail = await fetchRunDetail(runId);
      if (!detail) {
        toast.error("The run could not be loaded for a rerun.");
        return;
      }
      setDraft(draftFromRunDetail(detail));
      setViewedRun(detail);
      setActiveStep("setup");
      toast.success("Run loaded into the editor — adjust anything, then execute.");
    } finally {
      setRerunBusy(false);
    }
  }

  /** Test-data problems block profile saves the same way they block execution. */
  function setupIssueForProfileSave(): string | null {
    const dataIssues = testDataIssues(draft.setup.testData);
    if (dataIssues.length) return dataIssues[0];
    if (draft.setup.baseUrl.trim() && !isValidHttpUrl(draft.setup.baseUrl)) {
      return "The Base URL must start with http:// or https://.";
    }
    const viewportProblems = viewportIssues(draft.setup);
    if (viewportProblems.length) return viewportProblems[0];
    return null;
  }

  function applyProfile(profile: ExecutionProfileView) {
    setDraft((current) => applyProfileToDraft(current, profile));
    toast.success(`Profile "${profile.name}" applied.`);
  }

  async function saveProfile(name: string): Promise<boolean> {
    if (!scope) return false;
    const issue = setupIssueForProfileSave();
    if (issue) {
      toast.error(issue);
      return false;
    }
    setProfileBusy(true);
    try {
      const data = await postJson<{ profile: ExecutionProfileView }>(
        "/api/test-execution/playwright/profiles",
        setupToProfileRequest({ scope, name, setup: draft.setup }),
      );
      toast.success(`Profile "${data.profile.name}" saved.`);
      setDraft((current) => ({ ...current, setup: { ...current.setup, profileId: data.profile.id } }));
      await loadProfiles();
      return true;
    } catch (error) {
      toast.error(caughtErrorMessage(error, "The profile could not be saved."));
      return false;
    } finally {
      setProfileBusy(false);
    }
  }

  async function updateProfile() {
    if (!scope || !draft.setup.profileId) return;
    const selected = profiles.find((profile) => profile.id === draft.setup.profileId);
    if (!selected) return;
    const issue = setupIssueForProfileSave();
    if (issue) {
      toast.error(issue);
      return;
    }
    setProfileBusy(true);
    try {
      await postJson(
        `/api/test-execution/playwright/profiles/${selected.id}`,
        setupToProfileRequest({ scope, name: selected.name, setup: draft.setup }),
      );
      toast.success(`Profile "${selected.name}" updated.`);
      await loadProfiles();
    } catch (error) {
      toast.error(caughtErrorMessage(error, "The profile could not be updated."));
    } finally {
      setProfileBusy(false);
    }
  }

  async function deleteProfile() {
    if (!scope || !draft.setup.profileId) return;
    const profileId = draft.setup.profileId;
    setProfileBusy(true);
    try {
      await postJson(`/api/test-execution/playwright/profiles/${profileId}/delete`, { scope });
      toast.success("Profile deleted.");
      setDraft((current) => ({ ...current, setup: { ...current.setup, profileId: null } }));
      await loadProfiles();
    } catch (error) {
      toast.error(caughtErrorMessage(error, "The profile could not be deleted."));
    } finally {
      setProfileBusy(false);
    }
  }

  const warning = projectWarning(scope);
  if (warning) return <div className="content-stack">{warning}</div>;

  return (
    <div className="content-stack">
      {isJira ? (
        <Callout tone="info" title="Azure DevOps only for now">
          Test execution currently requires an Azure DevOps workspace. You can still browse past runs here.
        </Callout>
      ) : null}

      <WorkflowStepper
        steps={EXECUTION_STEPS}
        activeStepId={liveRun ? "review" : activeStep}
        completedStepIds={stepper.completedStepIds}
        enabledStepIds={stepper.enabledStepIds}
        onStepChange={stepper.locked ? undefined : setActiveStep}
        ariaLabel="Test Execution workflow"
      />

      {liveRun ? (
        <ReviewStep
          draft={draft}
          issues={issues}
          liveRun={liveRun}
          creating={creating}
          onExecute={() => void execute()}
          onCancelRun={() => void cancelRun()}
        />
      ) : activeStep === "setup" ? (
        <SetupStep
          setup={draft.setup}
          onSetupChange={setSetup}
          profiles={profiles}
          profilesLoading={profilesLoading}
          profileBusy={profileBusy}
          onApplyProfile={applyProfile}
          onSaveProfile={saveProfile}
          onUpdateProfile={updateProfile}
          onDeleteProfile={deleteProfile}
        />
      ) : activeStep === "cases" ? (
        <>
          <CaseImportPanel
            scope={scope}
            providerId={providerId}
            existingCases={draft.cases}
            onAddCases={addImportedCases}
          />
          <WorkingSetEditor cases={draft.cases} onChange={setCases} />
        </>
      ) : activeStep === "review" ? (
        <ReviewStep
          draft={draft}
          issues={issues}
          liveRun={null}
          creating={creating}
          onExecute={() => void execute()}
          onCancelRun={() => void cancelRun()}
        />
      ) : viewedRun && scope ? (
        <ResultsStep
          scope={scope}
          run={viewedRun}
          onRerun={() => requestRerun(viewedRun.id)}
          onPublish={(retryFailed) => void publish(retryFailed)}
          publishBusy={publishBusy}
        />
      ) : null}

      {!stepper.locked ? (
        <StepNav
          activeStep={activeStep}
          enabledStepIds={stepper.enabledStepIds}
          onNavigate={setActiveStep}
          nextBlockedReason={issues[0]}
        />
      ) : null}

      <RunHistoryCard
        runs={runs}
        loading={historyLoading}
        busy={rerunBusy || Boolean(liveRun)}
        onRefresh={() => void loadHistory()}
        onView={(runId) => void viewRun(runId)}
        onRerun={requestRerun}
      />

      <ConfirmationDialog
        open={Boolean(pendingRerunId)}
        onOpenChange={(open) => { if (!open) setPendingRerunId(null); }}
        title="Replace your current draft?"
        description="Loading this run replaces the setup and test cases you are editing, and the current draft cannot be recovered."
        confirmLabel="Replace and load run"
        cancelLabel="Keep my draft"
        onConfirm={() => {
          const runId = pendingRerunId;
          setPendingRerunId(null);
          if (runId) void stageRerun(runId);
        }}
      />
    </div>
  );
}
