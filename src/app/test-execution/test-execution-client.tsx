"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { postJson, patchJson, deleteJson } from "@/components/workflow/post-json";
import { ApiError } from "@/components/workflow/api-error";
import { projectWarning, useActiveProject } from "@/components/workflow/test-intelligence-shared";
import type { RunDetailDto } from "@/modules/test-execution/report-assembler";
import type { WorkspaceRole } from "@/modules/workspace/workspace-access.service";

import {
  EnvironmentStep,
  environmentAllowedOrigin,
  environmentCredentialTitles,
  environmentSecretNames,
  environmentTargets,
  type EnvironmentProfileSummary,
  type EnvironmentSelection,
  type OneTimeEnvironmentState,
  type ProfileUpdatePayload,
} from "./components/environment-step";
import {
  ScopeStep,
  type ImportableTestCase,
  type TestPlanOption,
  type TestSuiteOption,
} from "./components/scope-step";
import { ReviewExecuteStep } from "./components/review-execute-step";
import { ResultsStep, type CandidatePublishState } from "./components/results-step";
import { IntegrationCapabilitiesPanel } from "./components/integration-capabilities-panel";
import { WorkspaceEgressRulesPanel } from "./components/workspace-egress-rules-panel";
import { OutcomeBadge } from "./components/outcome-badge";
import { azureStepsToNaturalPlan, buildNaturalPlan } from "./lib/manual-step-form";
import {
  buildEnvironmentParts,
  buildConnectionSecrets,
  clampEnvironmentLimits,
  environmentPartsLimitIssue,
  unknownStepSecrets,
} from "./lib/environment-payload";
import {
  clearDraft,
  loadActiveRunId,
  loadDraft,
  saveActiveRunId,
  saveDraft,
  type DraftCase,
} from "./lib/draft-storage";
import { runPollDelay } from "./lib/run-polling";
import {
  TEST_EXECUTION_STEPS,
  deriveStepperState,
  isTerminalRunStatusValue,
  stepperLocked,
  type TestExecutionStepId,
} from "./lib/stepper-gating";

type RunListEntry = {
  id: string;
  status: string;
  outcome: string | null;
  storyWorkItemId: string | null;
  storyTitle: string | null;
  environmentName: string | null;
  caseCount: number;
  createdByName: string | null;
  createdAt: string;
};

export function TestExecutionClient({ workspaceRole }: { workspaceRole: WorkspaceRole | null }) {
  const scope = useActiveProject();
  const projectId = scope?.projectId ?? "";

  const [activeStep, setActiveStep] = useState<TestExecutionStepId>("environment");
  const [profiles, setProfiles] = useState<EnvironmentProfileSummary[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [updatingProfile, setUpdatingProfile] = useState(false);
  const [invalidatingSession, setInvalidatingSession] = useState(false);
  const [selection, setSelection] = useState<EnvironmentSelection | null>(null);
  const [selectedCapabilityIds, setSelectedCapabilityIds] = useState<string[]>([]);

  const [story, setStory] = useState({ workItemId: "", title: "" });
  const [linkedCases, setLinkedCases] = useState<ImportableTestCase[] | null>(null);
  const [linkedLoading, setLinkedLoading] = useState(false);
  const [linkedError, setLinkedError] = useState<string | null>(null);
  const [cases, setCases] = useState<DraftCase[]>([]);

  const [plans, setPlans] = useState<TestPlanOption[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [suites, setSuites] = useState<TestSuiteOption[]>([]);
  const [suitesLoading, setSuitesLoading] = useState(false);
  const [selectedSuiteId, setSelectedSuiteId] = useState("");
  const [suiteCases, setSuiteCases] = useState<ImportableTestCase[] | null>(null);
  const [suiteCasesLoading, setSuiteCasesLoading] = useState(false);
  const [planSuiteError, setPlanSuiteError] = useState<string | null>(null);
  /** One plans fetch per project visit; a failure is a passive banner — switching projects or revisiting refetches. */
  const plansRequestedRef = useRef(false);

  const [creating, setCreating] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetailDto | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [publishState, setPublishState] = useState<CandidatePublishState>({});

  const [recentRuns, setRecentRuns] = useState<RunListEntry[]>([]);

  const scopeQuery = useMemo(() => {
    if (!scope) return "";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(scope)) {
      if (typeof value === "string" && value) params.set(key, value);
    }
    return params.toString();
  }, [scope]);

  const runTerminal = isTerminalRunStatusValue(runDetail?.run.status ?? null);
  const capabilityEnvironment = useMemo(() => {
    const target = selection?.mode === "profile" ? selection.profile : selection?.mode === "one_time" ? selection.config : null;
    return {
      targets: environmentTargets(selection),
      databaseDriver: target?.database?.driver ?? null,
      apiMutationsEnabled: target?.api?.mutationMode === "approved_catalog",
      databaseDmlEnabled: target?.database?.accessMode === "cataloged_dml",
    };
  }, [selection]);
  // Hand-typed one-time environment content (notes, users, login steps) is as
  // costly to lose as authored cases — both arm the unsaved-changes guard.
  const oneTimeDirty =
    selection?.mode === "one_time" &&
    (selection.config.executionNotes.trim().length > 0 ||
      selection.config.defaultUsername.trim().length > 0 ||
      selection.config.defaultPassword.length > 0 ||
      selection.config.defaultOtp.length > 0 ||
      selection.config.users.length > 0 ||
      selection.config.loginSteps.length > 0 ||
      selection.config.secrets.length > 0 ||
      selection.config.api !== null ||
      selection.config.apiSecret.length > 0 ||
      selection.config.database !== null ||
      selection.config.databasePassword.length > 0);
  const dirty = (cases.length > 0 || oneTimeDirty) && runId === null;
  useUnsavedChangesGuard({ dirty, busy: creating });

  // ---- bootstrap: profiles, recent runs, draft, active run ----
  useEffect(() => {
    if (!scope) return;
    let disposed = false;
    setProfilesLoading(true);
    const draft = loadDraft(projectId);
    if (draft) {
      setStory({ workItemId: draft.storyWorkItemId, title: draft.storyTitle });
      setCases(draft.cases);
    }
    const draftProfileId = draft?.environmentProfileId ?? null;

    void fetch(`/api/test-execution/environments?${scopeQuery}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error("load failed"))))
      .then((body: { profiles: EnvironmentProfileSummary[] }) => {
        if (disposed) return;
        setProfiles(body.profiles);
        // Restore the profile choice saved with the draft, if it still exists.
        const draftProfile = draftProfileId ? body.profiles.find((profile) => profile.id === draftProfileId) : null;
        if (draftProfile) {
          setSelection((previous) => previous ?? { mode: "profile", profile: draftProfile });
        }
      })
      .catch(() => undefined)
      .finally(() => !disposed && setProfilesLoading(false));

    void fetch(`/api/test-execution/runs?${scopeQuery}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? response.json() : Promise.reject(new Error("load failed"))))
      .then((body: { runs: RunListEntry[]; activeRun: { id: string } | null }) => {
        if (disposed) return;
        setRecentRuns(body.runs);
        const persistedRun = body.activeRun?.id ?? loadActiveRunId(projectId);
        if (persistedRun) {
          setRunId(persistedRun);
          setActiveStep("review");
        }
      })
      .catch(() => undefined);

    // Plan/suite pickers are per-project; reset them on project switch.
    plansRequestedRef.current = false;
    setPlans([]);
    setSelectedPlanId("");
    setSuites([]);
    setSelectedSuiteId("");
    setSuiteCases(null);
    setPlanSuiteError(null);
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // ---- draft persistence ----
  useEffect(() => {
    if (!projectId || runId) return;
    if (cases.length === 0) {
      clearDraft(projectId);
      return;
    }
    saveDraft(projectId, {
      storyWorkItemId: story.workItemId,
      storyTitle: story.title,
      environmentProfileId: selection?.mode === "profile" ? selection.profile.id : null,
      cases,
    });
  }, [projectId, cases, story, selection, runId]);

  // ---- run polling ----
  const pollState = useRef({ startedAt: 0, failures: 0, timer: null as ReturnType<typeof setTimeout> | null });
  const fetchRunDetail = useCallback(async () => {
    if (!runId || !scopeQuery) return;
    try {
      const response = await fetch(`/api/test-execution/runs/${runId}?${scopeQuery}`, { cache: "no-store" });
      if (response.status === 404) {
        saveActiveRunId(projectId, null);
        setRunId(null);
        return;
      }
      if (!response.ok) throw new Error("poll failed");
      const detail: RunDetailDto = await response.json();
      pollState.current.failures = 0;
      setRunDetail(detail);
      if (isTerminalRunStatusValue(detail.run.status)) {
        saveActiveRunId(projectId, null);
        if (typeof document !== "undefined") {
          document.title = `${detail.run.outcome ?? detail.run.status} · Test Execution | iTestFlow`;
        }
      }
    } catch {
      pollState.current.failures += 1;
    }
  }, [runId, scopeQuery, projectId]);

  useEffect(() => {
    if (!runId) return;
    const state = pollState.current;
    state.startedAt = Date.now();
    let disposed = false;
    const tick = async () => {
      if (disposed) return;
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        await fetchRunDetail();
      }
      if (disposed) return;
      const latestTerminal = isTerminalRunStatusValue(
        (pollStateDetailRef.current?.run.status as string | undefined) ?? null,
      );
      if (latestTerminal) return;
      state.timer = setTimeout(
        () => void tick(),
        runPollDelay(Date.now() - state.startedAt, state.failures),
      );
    };
    void tick();
    const onShow = () => {
      if (document.visibilityState === "visible") void fetchRunDetail();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      disposed = true;
      if (state.timer) clearTimeout(state.timer);
      document.removeEventListener("visibilitychange", onShow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  // Keep the latest detail readable from the poll loop without re-arming it.
  const pollStateDetailRef = useRef<RunDetailDto | null>(null);
  useEffect(() => {
    pollStateDetailRef.current = runDetail;
  }, [runDetail]);

  // ---- actions ----
  const saveAsProfile = async (name: string, rawConfig: OneTimeEnvironmentState) => {
    if (!scope) return;
    setSavingProfile(true);
    try {
      const config = clampEnvironmentLimits(rawConfig);
      const parts = buildEnvironmentParts({
        defaultUsername: config.uiEnabled ? config.defaultUsername : "",
        defaultPassword: config.uiEnabled ? config.defaultPassword : "",
        defaultOtp: config.uiEnabled ? config.defaultOtp : "",
        extras: config.secrets,
        users: config.uiEnabled ? config.users : [],
      });
      const connectionSecrets = buildConnectionSecrets(config);
      const limitIssue = environmentPartsLimitIssue({ ...parts, secrets: [...parts.secrets, ...connectionSecrets] });
      if (limitIssue) {
        toast.error(limitIssue);
        return;
      }
      const unknownTokens = config.uiEnabled ? unknownStepSecrets(config.loginSteps, parts.validSecretNames) : [];
      if (unknownTokens.length > 0) {
        toast.warning(`The login sequence mentions unknown credential(s): ${unknownTokens.join(", ")}.`);
      }
      const body = await postJson<{ profile: EnvironmentProfileSummary }>("/api/test-execution/environments", {
        scope,
        config: {
          name,
          initialUrl: config.uiEnabled ? config.initialUrl : "",
          allowedOrigin: config.uiEnabled ? config.allowedOrigin || safeOrigin(config.initialUrl) : "",
          viewportWidth: config.viewportWidth,
          viewportHeight: config.viewportHeight,
          headless: config.headless,
          defaultTimeoutMs: config.defaultTimeoutMs,
          navigationTimeoutMs: config.navigationTimeoutMs,
          evidenceLevel: config.evidenceLevel,
          loginPlan: config.uiEnabled ? buildNaturalPlan(config.loginSteps) : null,
          loginMode: config.loginMode,
          loggedInText: config.loggedInText.trim(),
          executionNotes: config.executionNotes.trim(),
          api: config.api,
          database: config.database,
          users: parts.users,
        },
        secrets: [...parts.secrets, ...connectionSecrets],
      });
      setProfiles((previous) => [body.profile, ...previous]);
      setSelection({ mode: "profile", profile: body.profile });
      toast.success(`Environment profile "${name}" saved.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The profile could not be saved.");
    } finally {
      setSavingProfile(false);
    }
  };

  const updateProfile = async (profileId: string, payload: ProfileUpdatePayload): Promise<boolean> => {
    if (!scope) return false;
    setUpdatingProfile(true);
    try {
      const body = await patchJson<{ profile: EnvironmentProfileSummary }>(
        `/api/test-execution/environments/${profileId}`,
        {
          scope,
          config: payload.config,
          upsertSecrets: payload.upsertSecrets,
          removeSecretNames: payload.removeSecretNames,
        },
      );
      setProfiles((previous) => previous.map((profile) => (profile.id === profileId ? body.profile : profile)));
      setSelection((previous) =>
        previous?.mode === "profile" && previous.profile.id === profileId
          ? { mode: "profile", profile: body.profile }
          : previous,
      );
      toast.success(`Environment profile "${body.profile.name}" updated.`);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The profile could not be updated.");
      return false;
    } finally {
      setUpdatingProfile(false);
    }
  };

  const invalidateSession = async (profileId: string) => {
    if (!scope) return;
    setInvalidatingSession(true);
    try {
      await deleteJson<{ deleted: boolean }>(`/api/test-execution/environments/${profileId}/session`, { scope });
      const clear = (profile: EnvironmentProfileSummary): EnvironmentProfileSummary =>
        profile.id === profileId ? { ...profile, sessionCapturedAt: null } : profile;
      setProfiles((previous) => previous.map(clear));
      setSelection((previous) =>
        previous?.mode === "profile" && previous.profile.id === profileId
          ? { mode: "profile", profile: clear(previous.profile) }
          : previous,
      );
      toast.success("Saved login session invalidated — the next run logs in fresh.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The saved login session could not be invalidated.");
    } finally {
      setInvalidatingSession(false);
    }
  };

  const loadLinkedCases = async () => {
    if (!scope || !story.workItemId) return;
    setLinkedLoading(true);
    setLinkedError(null);
    try {
      const body = await postJson<{ linkedTestCases: ImportableTestCase[] }>(
        "/api/azure-devops/linked-test-cases",
        { scope, userStoryId: story.workItemId },
      );
      setLinkedCases(body.linkedTestCases);
    } catch (error) {
      setLinkedError(error instanceof Error ? error.message : "Linked test cases could not be loaded.");
      setLinkedCases(null);
    } finally {
      setLinkedLoading(false);
    }
  };

  const loadPlans = useCallback(async () => {
    if (!scope) return;
    if (plansRequestedRef.current) return;
    plansRequestedRef.current = true;
    setPlansLoading(true);
    setPlanSuiteError(null);
    try {
      const body = await postJson<{ testPlans: TestPlanOption[] }>("/api/azure-devops/test-plans", { scope });
      setPlans(body.testPlans);
    } catch (error) {
      // One attempt per visit — never auto-retry a failing integration call.
      // 403 means the PAT/project lacks Test Plans access; the rest of the
      // page (story import, manual cases) still works.
      if (error instanceof ApiError && (error.status === 403 || error.status === 401)) {
        setPlanSuiteError(
          "You don't have access to Test Plans in this project (check the PAT's Test Plans scope or project permissions). Story import and manual cases still work.",
        );
      } else {
        setPlanSuiteError(error instanceof Error ? error.message : "Test plans could not be loaded.");
      }
    } finally {
      setPlansLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  // Test plans load lazily, ONCE, the first time the scope step is shown;
  // failures surface as a passive banner (same model as Suite Migration) —
  // switching projects or revisiting the page refetches.
  useEffect(() => {
    if (activeStep === "scope") void loadPlans();
  }, [activeStep, loadPlans]);

  const selectPlan = async (planId: string) => {
    setSelectedPlanId(planId);
    setSelectedSuiteId("");
    setSuiteCases(null);
    setSuites([]);
    if (!scope || !planId) return;
    setSuitesLoading(true);
    setPlanSuiteError(null);
    try {
      const body = await postJson<{ testSuites: TestSuiteOption[] }>("/api/azure-devops/test-suites", {
        scope,
        testPlanId: planId,
      });
      setSuites(body.testSuites);
    } catch (error) {
      setPlanSuiteError(error instanceof Error ? error.message : "Test suites could not be loaded.");
    } finally {
      setSuitesLoading(false);
    }
  };

  const loadSuiteCases = async () => {
    if (!scope || !selectedPlanId || !selectedSuiteId) return;
    setSuiteCasesLoading(true);
    setPlanSuiteError(null);
    try {
      const body = await postJson<{ testCases: ImportableTestCase[] }>("/api/azure-devops/suite-test-cases", {
        scope,
        testPlanId: selectedPlanId,
        testSuiteId: selectedSuiteId,
      });
      setSuiteCases(body.testCases);
    } catch (error) {
      setPlanSuiteError(error instanceof Error ? error.message : "Suite test cases could not be loaded.");
      setSuiteCases(null);
    } finally {
      setSuiteCasesLoading(false);
    }
  };

  const addImportedCase = (testCase: ImportableTestCase) => {
    const azureId = testCase.azureTestCaseId ?? testCase.id;
    const plan = azureStepsToNaturalPlan(testCase.steps);
    if (!plan) {
      toast.error("This test case has no usable steps.");
      return;
    }
    setCases((previous) => [
      ...previous,
      { title: testCase.title, sourceKind: "azure_test_case", azureTestCaseId: azureId, plan },
    ]);
    toast.success(`"${testCase.title}" added — review or edit its steps freely.`);
  };

  const addImportedCases = (testCases: ImportableTestCase[]) => {
    const additions: DraftCase[] = [];
    let skipped = 0;
    for (const testCase of testCases) {
      const plan = azureStepsToNaturalPlan(testCase.steps);
      if (!plan) {
        skipped += 1;
        continue;
      }
      additions.push({
        title: testCase.title,
        sourceKind: "azure_test_case",
        azureTestCaseId: testCase.azureTestCaseId ?? testCase.id,
        plan,
      });
    }
    if (additions.length === 0) {
      toast.error("None of these test cases have usable steps.");
      return;
    }
    setCases((previous) => [...previous, ...additions]);
    toast.success(
      `${additions.length} test case(s) added${skipped > 0 ? ` (${skipped} skipped — no usable steps)` : ""}.`,
    );
  };

  const removeImportedCases = (testCases: ImportableTestCase[]) => {
    const ids = new Set(testCases.map((testCase) => testCase.azureTestCaseId ?? testCase.id));
    const kept = cases.filter((entry) => !entry.azureTestCaseId || !ids.has(entry.azureTestCaseId));
    const removed = cases.length - kept.length;
    if (removed === 0) return;
    setCases(kept);
    toast.info(`${removed} test case(s) removed from this run.`);
  };

  const approveAndExecute = async () => {
    if (!scope || !selection) return;
    setCreating(true);
    try {
      let environment;
      if (selection.mode === "profile") {
        environment = { mode: "profile" as const, environmentProfileId: selection.profile.id };
      } else {
        const config = clampEnvironmentLimits(selection.config);
        const parts = buildEnvironmentParts({
          defaultUsername: config.uiEnabled ? config.defaultUsername : "",
          defaultPassword: config.uiEnabled ? config.defaultPassword : "",
          defaultOtp: config.uiEnabled ? config.defaultOtp : "",
          extras: config.secrets,
          users: config.uiEnabled ? config.users : [],
        });
        const connectionSecrets = buildConnectionSecrets(config);
        const limitIssue = environmentPartsLimitIssue({ ...parts, secrets: [...parts.secrets, ...connectionSecrets] });
        if (limitIssue) {
          toast.error(limitIssue);
          return;
        }
        const unknownTokens = config.uiEnabled ? unknownStepSecrets(config.loginSteps, parts.validSecretNames) : [];
        if (unknownTokens.length > 0) {
          toast.warning(`The login sequence mentions unknown credential(s): ${unknownTokens.join(", ")}.`);
        }
        environment = {
          mode: "one_time" as const,
          config: {
            initialUrl: config.uiEnabled ? config.initialUrl : "",
            allowedOrigin: config.uiEnabled ? config.allowedOrigin || safeOrigin(config.initialUrl) : "",
            viewportWidth: config.viewportWidth,
            viewportHeight: config.viewportHeight,
            headless: config.headless,
            defaultTimeoutMs: config.defaultTimeoutMs,
            navigationTimeoutMs: config.navigationTimeoutMs,
            evidenceLevel: config.evidenceLevel,
            loginPlan: config.uiEnabled ? buildNaturalPlan(config.loginSteps) : null,
            loginMode: config.loginMode,
            loggedInText: config.loggedInText.trim(),
            executionNotes: config.executionNotes.trim(),
            api: config.api,
            database: config.database,
            users: parts.users,
          },
          secrets: [...parts.secrets, ...connectionSecrets],
        };
      }
      const body = await postJson<{ runId: string }>("/api/test-execution/runs", {
        scope,
        environment,
        capabilityRevisionIds: selectedCapabilityIds,
        story: story.workItemId ? { workItemId: story.workItemId, title: story.title } : null,
        cases: cases.map((entry) => ({
          title: entry.title,
          sourceKind: entry.sourceKind,
          azureTestCaseId: entry.azureTestCaseId,
          plan: entry.plan,
        })),
      });
      setRunId(body.runId);
      saveActiveRunId(projectId, body.runId);
      clearDraft(projectId);
      setRunDetail(null);
      toast.success("Run approved and queued.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The run could not be started.");
    } finally {
      setCreating(false);
    }
  };

  const cancelRun = async () => {
    if (!scope || !runId) return;
    setCancelPending(true);
    try {
      await postJson(`/api/test-execution/runs/${runId}/cancel`, { scope });
      toast.info("Cancellation requested — the active operation will stop at the next safe checkpoint.");
      await fetchRunDetail();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The run could not be canceled.");
    } finally {
      setCancelPending(false);
    }
  };

  const updateCandidate = async (candidateId: string, patch: { status?: string; draft?: Record<string, unknown> }) => {
    if (!scope) return;
    try {
      await patchJson(`/api/test-execution/defect-candidates/${candidateId}`, { scope, ...patch });
      await fetchRunDetail();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The candidate could not be updated.");
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
      await fetchRunDetail();
    } catch (error) {
      setPublishState((previous) => ({
        ...previous,
        [candidateId]: {
          pending: false,
          error: error instanceof Error ? error.message : "Publish failed.",
          azureBugId: null,
        },
      }));
    }
  };

  const rerunCases = (draftCases: DraftCase[]) => {
    setCases(draftCases);
    setRunId(null);
    setRunDetail(null);
    saveActiveRunId(projectId, null);
    setActiveStep("review");
    toast.info(`${draftCases.length} case(s) staged for a new run — approve to execute.`);
  };

  const startFresh = () => {
    setCases([]);
    setRunId(null);
    setRunDetail(null);
    setPublishState({});
    saveActiveRunId(projectId, null);
    clearDraft(projectId);
    setActiveStep("environment");
  };

  // ---- render ----
  if (!scope) return <div className="content-stack">{projectWarning(scope)}</div>;

  const stepperInputs = {
    environmentReady: selection !== null,
    caseCount: cases.length,
    runId,
    runTerminal,
  };
  const { completedStepIds, enabledStepIds } = deriveStepperState(stepperInputs);
  const locked = stepperLocked(stepperInputs);

  return (
    <div className="content-stack">
      <WorkflowStepper
        steps={TEST_EXECUTION_STEPS.map((step) => ({ id: step.id, label: step.label, shortLabel: step.shortLabel }))}
        activeStepId={activeStep}
        completedStepIds={completedStepIds}
        enabledStepIds={locked ? [activeStep] : enabledStepIds}
        onStepChange={locked ? undefined : (stepId) => setActiveStep(stepId as TestExecutionStepId)}
        ariaLabel="Test Execution workflow"
      />

      {activeStep === "environment" ? (
        <EnvironmentStep
          profiles={profiles}
          profilesLoading={profilesLoading}
          selection={selection}
          onSelectionChange={setSelection}
          onSaveAsProfile={saveAsProfile}
          saving={savingProfile}
          onUpdateProfile={updateProfile}
          updatingProfile={updatingProfile}
          onContinue={() => setActiveStep("scope")}
          capabilitiesPanel={
            <div className="space-y-4">
              <WorkspaceEgressRulesPanel scope={scope} workspaceRole={workspaceRole} />
              <IntegrationCapabilitiesPanel
                scope={scope}
                workspaceRole={workspaceRole}
                environment={capabilityEnvironment}
                selectedIds={selectedCapabilityIds}
                onSelectedIdsChange={setSelectedCapabilityIds}
              />
            </div>
          }
          onInvalidateSession={invalidateSession}
          invalidatingSession={invalidatingSession}
        />
      ) : null}

      {activeStep === "scope" ? (
        <ScopeStep
          story={story}
          onStoryChange={setStory}
          onLoadLinkedCases={loadLinkedCases}
          linkedCases={linkedCases}
          linkedLoading={linkedLoading}
          linkedError={linkedError}
          planSuite={{
            plans,
            plansLoading,
            selectedPlanId,
            onSelectPlan: (planId) => void selectPlan(planId),
            suites,
            suitesLoading,
            selectedSuiteId,
            onSelectSuite: setSelectedSuiteId,
            onLoadSuiteCases: loadSuiteCases,
            suiteCases,
            suiteCasesLoading,
            error: planSuiteError,
          }}
          cases={cases}
          onCasesChange={setCases}
          onAddImportedCase={addImportedCase}
          onAddImportedCases={addImportedCases}
          onRemoveImportedCases={removeImportedCases}
          availableCredentialTitles={environmentCredentialTitles(selection)}
          onContinue={() => setActiveStep("review")}
          onBack={() => setActiveStep("environment")}
        />
      ) : null}

      {activeStep === "review" ? (
        <ReviewExecuteStep
          cases={cases}
          environmentLabel={selection?.mode === "profile" ? selection.profile.name : "One-time environment"}
          allowedOrigin={environmentAllowedOrigin(selection)}
          environmentTargets={environmentTargets(selection)}
          capabilityCount={selectedCapabilityIds.length}
          availableSecretNames={environmentSecretNames(selection)}
          storyWorkItemId={story.workItemId || null}
          run={runId ? runDetail : null}
          creating={creating}
          onApprove={approveAndExecute}
          onCancelRun={cancelRun}
          cancelPending={cancelPending}
          onBack={() => setActiveStep("scope")}
          onViewResults={() => setActiveStep("results")}
        />
      ) : null}

      {activeStep === "results" ? (
        runDetail ? (
          <>
            <ResultsStep
              detail={runDetail}
              artifactUrl={(artifactId) => `/api/test-execution/runs/${runDetail.run.id}/artifacts/${artifactId}?${scopeQuery}`}
              onRerunCases={rerunCases}
              onUpdateCandidate={updateCandidate}
              onPublishCandidate={publishCandidate}
              publishState={publishState}
            />
            <div className="flex justify-end">
              <Button variant="outline" onClick={startFresh}>Start a new run</Button>
            </div>
          </>
        ) : (
          <div className="h-40 animate-pulse rounded-md bg-muted" aria-label="Loading results" />
        )
      ) : null}

      {activeStep === "environment" && recentRuns.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent runs</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Story</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Created by</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <p className="text-sm font-medium">{run.environmentName ?? "One-time environment"}</p>
                      <p className="text-xs text-muted-foreground">
                        {run.caseCount} test case{run.caseCount === 1 ? "" : "s"}
                      </p>
                    </TableCell>
                    <TableCell>{run.storyWorkItemId ? `#${run.storyWorkItemId} ${run.storyTitle ?? ""}` : "—"}</TableCell>
                    <TableCell><OutcomeBadge outcome={run.outcome ?? run.status} /></TableCell>
                    <TableCell className="text-sm text-muted-foreground">{run.createdByName ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{new Date(run.createdAt).toLocaleString()}</TableCell>
                    <TableCell>
                      <Button asChild variant="ghost" size="sm">
                        <a href={`/test-execution/runs/${run.id}`}>Open report</a>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}
