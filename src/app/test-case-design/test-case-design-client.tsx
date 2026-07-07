"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ClipboardList, ListChecks, Loader2, Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/qa/callout";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress";
import { AiGenerationCompletedMetrics } from "@/components/workflow/ai-generation-metrics";
import { WorkflowContextCitations } from "@/components/workflow/workflow-context-citations";
import { useAiGeneration } from "@/components/workflow/use-ai-generation";
import { useLlmLoadingGameSession } from "@/components/workflow/llm-loading-games/use-llm-loading-game-session";
import { ExtraInstructionsField } from "@/components/workflow/extra-instructions-field";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import {
  GeneratedTestCasesReview,
  validateGeneratedTestCase,
} from "@/components/workflow/generated-test-cases-review";
import { WorkItemPreview, useWorkItemLookup, WORK_ITEM_ID_PLACEHOLDER, WORK_ITEM_ID_TITLE } from "@/components/workflow/work-item-loader";
import {
  EmptyBlock,
  PublishGeneratedCasesPanel,
  SectionCard,
  postJson,
  projectWarning,
  scrollToNextStep,
  useActiveProject,
} from "@/components/workflow/test-intelligence-shared";
import type {
  ApiState,
  GeneratedTestCase,
  ManualPromptDraft,
  TestCaseGenerationRunResult,
  WorkflowMode,
} from "@/components/workflow/test-intelligence-types";
import {
  allCoverageFocusIds,
  coverageFocusOptions,
  defaultTestDesignOptions,
  maxCustomTestCaseRange,
  targetTestCaseRangeOptions,
  type CoverageFocusId,
  type TargetTestCaseRangeId,
  type TestDesignOptions,
} from "@/modules/test-case-design/test-design-options";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH, normalizeExtraInstructions } from "@/modules/llm/extra-instructions";
import { cn } from "@/lib/utils";
import { caughtErrorMessage } from "@/shared/lib/api-error-message";

export function TestCaseDesignClient() {
  const scope = useActiveProject();
  const generatedCasesRef = useRef<HTMLDivElement | null>(null);
  const promptSectionRef = useRef<HTMLDivElement | null>(null);
  const [activeStep, setActiveStep] = useState<"generate" | "review">("generate");
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const workItemLookup = useWorkItemLookup({ scope, workItemId: targetWorkItemId });
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [state, setState] = useState<ApiState<TestCaseGenerationRunResult>>({ loading: false, error: null, data: null });
  const gen = useAiGeneration();
  const prep = useAiGeneration({ prepareMs: 400, buildPromptMs: 500 });
  const loadingGame = useLlmLoadingGameSession<TestCaseGenerationRunResult>((data) => {
    applyGeneratedCases(data);
    scrollToNextStep(generatedCasesRef);
  });
  const cancelGeneration = gen.cancel;
  const cancelPreparation = prep.cancel;
  const endLoadingGameSession = loadingGame.endSession;
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);
  const [selectedTestCaseIds, setSelectedTestCaseIds] = useState<string[]>([]);
  const [testDesignSettings, setTestDesignSettings] = useState<TestDesignOptions>(() => ({
    ...defaultTestDesignOptions,
    coverageFocusIds: [...defaultTestDesignOptions.coverageFocusIds],
  }));
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({
    dirty: hasUnfinishedWork,
    busy: state.loading || manualDraft.loading || manualSubmitLoading || gen.isRunning || prep.isRunning,
  });
  useEffect(() => {
    cancelGeneration();
    cancelPreparation();
    endLoadingGameSession();
    setActiveStep("generate");
    setTargetWorkItemId("");
    setHasUnfinishedWork(false);
    setState({ loading: false, error: null, data: null });
    setTestCases([]);
    setSelectedTestCaseIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }, [scope?.azureProjectId, cancelGeneration, cancelPreparation, endLoadingGameSession]);
  const selectedTargetRangeOption = useMemo(
    () =>
      targetTestCaseRangeOptions.find((option) => option.id === testDesignSettings.targetTestCaseRange) ??
      targetTestCaseRangeOptions[0],
    [testDesignSettings.targetTestCaseRange],
  );
  const coverageFocusSelectionValid = testDesignSettings.coverageFocusIds.length > 0;
  const customRangeValid =
    testDesignSettings.targetTestCaseRange !== "custom" ||
    (Number.isInteger(testDesignSettings.customMinCases) &&
      Number.isInteger(testDesignSettings.customMaxCases) &&
      (testDesignSettings.customMinCases ?? 0) >= 1 &&
      (testDesignSettings.customMaxCases ?? 0) <= maxCustomTestCaseRange &&
      (testDesignSettings.customMinCases ?? 0) <= (testDesignSettings.customMaxCases ?? 0));
  const testDesignOptionsValid = coverageFocusSelectionValid && customRangeValid;
  const extraInstructionsValid = extraInstructions.length <= EXTRA_INSTRUCTIONS_MAX_LENGTH;
  const selectedTestCases = useMemo(() => {
    const selectedIds = new Set(selectedTestCaseIds);
    return testCases.filter((testCase) => selectedIds.has(testCase.id));
  }, [selectedTestCaseIds, testCases]);
  const invalidSelectedCaseCount = useMemo(
    () => selectedTestCases.filter((testCase) => !validateGeneratedTestCase(testCase).valid).length,
    [selectedTestCases],
  );
  const editedSelectedCaseCount = useMemo(() => {
    const originalById = new Map((state.data?.testCases ?? []).map((testCase) => [testCase.id, testCase]));
    return selectedTestCases.filter((testCase) => JSON.stringify(testCase) !== JSON.stringify(originalById.get(testCase.id))).length;
  }, [selectedTestCases, state.data?.testCases]);

  function changeTargetWorkItemId(value: string) {
    gen.cancel();
    prep.cancel();
    loadingGame.endSession();
    setActiveStep("generate");
    setHasUnfinishedWork(true);
    setTargetWorkItemId(value);
    setState({ loading: false, error: null, data: null });
    setTestCases([]);
    setSelectedTestCaseIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeExtraInstructions(value: string) {
    gen.cancel();
    prep.cancel();
    loadingGame.endSession();
    setActiveStep("generate");
    setHasUnfinishedWork(true);
    setExtraInstructions(value);
    setState({ loading: false, error: null, data: null });
    setTestCases([]);
    setSelectedTestCaseIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function resetManualDraftForTestDesignOptionsChange() {
    gen.cancel();
    prep.cancel();
    loadingGame.endSession();
    setActiveStep("generate");
    setState({ loading: false, error: null, data: null });
    setTestCases([]);
    setSelectedTestCaseIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeTargetTestCaseRange(targetTestCaseRange: TargetTestCaseRangeId) {
    setHasUnfinishedWork(true);
    const nextRangeOption = targetTestCaseRangeOptions.find((option) => option.id === targetTestCaseRange) ?? selectedTargetRangeOption;
    setTestDesignSettings((current) => ({
      ...current,
      targetTestCaseRange,
      customMinCases: targetTestCaseRange === "custom" ? current.customMinCases ?? nextRangeOption.minCases : undefined,
      customMaxCases: targetTestCaseRange === "custom" ? current.customMaxCases ?? nextRangeOption.maxCases : undefined,
    }));
    resetManualDraftForTestDesignOptionsChange();
  }

  function changeCustomRange(field: "customMinCases" | "customMaxCases", value: string) {
    setHasUnfinishedWork(true);
    const parsed = value ? Number(value) : undefined;
    setTestDesignSettings((current) => ({
      ...current,
      [field]: Number.isFinite(parsed) ? parsed : undefined,
    }));
    resetManualDraftForTestDesignOptionsChange();
  }

  function changeCoverageFocusSelection(focusId: CoverageFocusId, checked: boolean) {
    setHasUnfinishedWork(true);
    setTestDesignSettings((current) => {
      const nextIds = new Set(current.coverageFocusIds);
      if (checked) {
        nextIds.add(focusId);
      } else {
        nextIds.delete(focusId);
      }
      return {
        ...current,
        coverageFocusIds: allCoverageFocusIds.filter((id) => nextIds.has(id)),
      };
    });
    resetManualDraftForTestDesignOptionsChange();
  }

  function selectAllCoverageFocusItems() {
    setHasUnfinishedWork(true);
    setTestDesignSettings((current) => ({ ...current, coverageFocusIds: [...allCoverageFocusIds] }));
    resetManualDraftForTestDesignOptionsChange();
  }

  function clearAllCoverageFocusItems() {
    setHasUnfinishedWork(true);
    setTestDesignSettings((current) => ({ ...current, coverageFocusIds: [] }));
    resetManualDraftForTestDesignOptionsChange();
  }

  function buildTestDesignOptionsRequest(): TestDesignOptions {
    return {
      targetTestCaseRange: testDesignSettings.targetTestCaseRange,
      customMinCases: testDesignSettings.targetTestCaseRange === "custom" ? testDesignSettings.customMinCases : undefined,
      customMaxCases: testDesignSettings.targetTestCaseRange === "custom" ? testDesignSettings.customMaxCases : undefined,
      coverageFocusIds: testDesignSettings.coverageFocusIds,
    };
  }

  function applyGeneratedCases(data: TestCaseGenerationRunResult) {
    setActiveStep("review");
    setHasUnfinishedWork(data.testCases.length > 0);
    setState({ loading: false, error: null, data });
    setTestCases(data.testCases);
    setSelectedTestCaseIds(data.testCases.map((testCase) => testCase.id));
  }

  async function generate() {
    if (!scope || !targetWorkItemId || !testDesignOptionsValid || !extraInstructionsValid) return;
    if (gen.isRunning) return;
    loadingGame.startSession();
    setState({ loading: true, error: null, data: null });
    setTestCases([]);
    setSelectedTestCaseIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    const data = await gen.start((signal) =>
      postJson<TestCaseGenerationRunResult>(
        "/api/test-cases/generate",
        {
          scope,
          targetWorkItemId,
          options: buildTestDesignOptionsRequest(),
          extraInstructions: normalizeExtraInstructions(extraInstructions),
        },
        signal,
      ),
    );
    if (data) {
      loadingGame.completeSession(data);
    } else {
      loadingGame.endSession();
      setState({ loading: false, error: null, data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !testDesignOptionsValid || !extraInstructionsValid) return;
    if (prep.isRunning) return;
    setState({ loading: false, error: null, data: null });
    setTestCases([]);
    setSelectedTestCaseIds([]);
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    scrollToNextStep(promptSectionRef);
    const data = await prep.start((signal) =>
      postJson<ManualPromptDraft>(
        "/api/test-cases/manual/draft",
        {
          scope,
          targetWorkItemId,
          options: buildTestDesignOptionsRequest(),
          extraInstructions: normalizeExtraInstructions(extraInstructions),
        },
        signal,
      ),
    );
    if (data) {
      setManualDraft({ loading: false, error: null, data });
      scrollToNextStep(promptSectionRef);
    } else {
      setManualDraft({ loading: false, error: null, data: null });
    }
  }

  async function submitManualResponse() {
    if (!scope || !targetWorkItemId || !manualDraft.data || !manualResponse.trim()) return;
    setManualSubmitLoading(true);
    setManualSubmitError(null);
    try {
      const data = await postJson<TestCaseGenerationRunResult>("/api/test-cases/manual/submit", {
        scope,
        targetWorkItemId,
        rawOutput: manualResponse,
        selectedContextIds: manualDraft.data.selectedContextIds ?? [],
        resolvedContextUsed: manualDraft.data.resolvedContextUsed ?? [],
        contextCitations: manualDraft.data.contextCitations,
        retrievalTopK: manualDraft.data.retrievalTopK,
      });
      applyGeneratedCases(data);
      scrollToNextStep(generatedCasesRef);
    } catch (error) {
      setManualSubmitError(caughtErrorMessage(error, "External LLM response validation failed."));
    } finally {
      setManualSubmitLoading(false);
    }
  }

  return (
    <div className="content-stack">
      {projectWarning(scope)}
      <WorkflowStepper
        steps={[
          {
            id: "generate",
            label: "Generate Test Cases",
            description: "Select the requirement and generation options.",
            icon: ClipboardList,
          },
          {
            id: "review",
            label: "Generated Test Cases Review",
            description: "Edit, select, and publish approved test cases.",
            icon: ListChecks,
          },
        ]}
        activeStepId={activeStep}
        completedStepIds={state.data ? ["generate"] : []}
        enabledStepIds={state.data ? ["generate", "review"] : ["generate"]}
        onStepChange={setActiveStep}
        ariaLabel="Test Case Design workflow"
      />

      {activeStep === "generate" ? (
        <div className="content-stack">
          <SectionCard
            title="Generate Test Cases from Azure DevOps Requirement"
            description="Project context is selected automatically for this run."
            action={
              <GenerationModeToggle
                mode={mode}
                onChange={(nextMode) => {
                  setHasUnfinishedWork(true);
                  setMode(nextMode);
                }}
              />
            }
          >
            <div className="space-y-4 p-4">
              <div className="grid items-end gap-4 lg:grid-cols-[240px_auto]">
                <div className="space-y-2">
                  <Label htmlFor="test-case-design-work-item-id" className="text-sm font-semibold text-foreground">
                    {WORK_ITEM_ID_TITLE}
                  </Label>
                  <Input
                    id="test-case-design-work-item-id"
                    value={targetWorkItemId}
                    inputMode="numeric"
                    onChange={(event) => changeTargetWorkItemId(event.target.value)}
                    placeholder={WORK_ITEM_ID_PLACEHOLDER}
                    title={WORK_ITEM_ID_TITLE}
                    aria-label={WORK_ITEM_ID_TITLE}
                  />
                </div>
                {mode === "auto" ? (
                  <Button onClick={generate} disabled={!scope || !targetWorkItemId || gen.isRunning || !testDesignOptionsValid || !extraInstructionsValid}>
                    {gen.isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {gen.isRunning ? "Generating..." : "Generate"}
                  </Button>
                ) : (
                  <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || prep.isRunning || !testDesignOptionsValid || !extraInstructionsValid}>
                    {prep.isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    {prep.isRunning ? "Preparing..." : "Prepare Prompt"}
                  </Button>
                )}
              </div>
              <WorkItemPreview scope={scope} workItemId={targetWorkItemId} lookup={workItemLookup} />
              <ExtraInstructionsField value={extraInstructions} onChange={changeExtraInstructions} />
              <TestDesignOptionsSelector
                settings={testDesignSettings}
                customRangeValid={customRangeValid}
                coverageFocusSelectionValid={coverageFocusSelectionValid}
                onTargetRangeChange={changeTargetTestCaseRange}
                onCustomRangeChange={changeCustomRange}
                onCoverageFocusToggle={changeCoverageFocusSelection}
                onSelectAllCoverageFocus={selectAllCoverageFocusItems}
                onClearAllCoverageFocus={clearAllCoverageFocusItems}
              />
            </div>
          </SectionCard>

          <div ref={promptSectionRef} className="scroll-mt-4 space-y-4">
            {mode === "manual" && prep.status !== "idle" && prep.status !== "completed" ? (
              <AiGenerationProgress
                mode="prep"
                variant="test-design"
                status={prep.status}
                elapsedSeconds={prep.elapsedSeconds}
                error={prep.error}
                errorMessage={prep.errorMessage}
                canCancel
                onCancel={prep.cancel}
                onRetry={() => {
                  prep.retry();
                  void prepareManualPrompt();
                }}
              />
            ) : null}

            {mode === "manual" && (manualDraft.data || manualSubmitError) ? (
              <div className="space-y-4">
                {manualSubmitError ? <Callout tone="error" role="alert">{manualSubmitError}</Callout> : null}
                {manualDraft.data ? (
                  <ManualLLMPanel
                    prompt={manualDraft.data.prompt}
                    promptVersion={manualDraft.data.promptVersion}
                    contextCitations={manualDraft.data.contextCitations}
                    response={manualResponse}
                    onResponseChange={(value) => {
                      setHasUnfinishedWork(true);
                      setManualResponse(value);
                    }}
                    onSubmit={submitManualResponse}
                    submitting={manualSubmitLoading}
                    submitLabel="Validate and Continue"
                    submittingLabel="Validating..."
                    responseLabel="External LLM Response"
                    promptMinHeightClass="min-h-[360px]"
                    responseMinHeightClass="min-h-[260px]"
                  />
                ) : null}
              </div>
            ) : null}
          </div>

          {gen.status !== "idle" && (gen.status !== "completed" || loadingGame.shouldKeepPanelMounted) ? (
            <AiGenerationProgress
              variant="test-design"
              status={gen.status}
              elapsedSeconds={gen.elapsedSeconds}
              error={gen.error}
              errorMessage={gen.errorMessage}
              canCancel
              onCancel={gen.cancel}
              onRetry={() => {
                gen.retry();
                void generate();
              }}
              loadingGame={loadingGame.panel}
            />
          ) : null}
        </div>
      ) : (
        <div ref={generatedCasesRef} className="content-stack pb-24">
          <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div role="heading" aria-level={2} className="text-sm font-semibold text-foreground">
                Reviewing generated test cases for <span className="font-mono font-semibold text-primary">#{targetWorkItemId}</span>
                {workItemLookup.data?.title ? (
                  <span className="block truncate font-normal text-muted-foreground"> — {workItemLookup.data.title}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">Generated content stays available while you revisit the inputs.</div>
            </div>
            <Button type="button" variant="outline" onClick={() => setActiveStep("generate")}>
              <ArrowLeft className="size-4" />
              Back to inputs
            </Button>
          </div>
          {state.data ? (
            <>
              <div className="space-y-4">
                {mode === "auto" && gen.status === "completed" ? (
                  <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} warnings={gen.warnings} />
                ) : null}
                <WorkflowContextCitations citations={state.data.contextCitations ?? []} />
                <GeneratedTestCasesReview
                  testCases={testCases}
                  onChange={(nextCases) => {
                    setHasUnfinishedWork(true);
                    setTestCases(nextCases);
                  }}
                  selectedIds={selectedTestCaseIds}
                  onSelectedIdsChange={(ids) => {
                    setHasUnfinishedWork(true);
                    setSelectedTestCaseIds(ids);
                  }}
                />
              </div>
              <PublishGeneratedCasesPanel
                scope={scope}
                targetWorkItemId={targetWorkItemId}
                testCases={selectedTestCases}
                invalidCaseCount={invalidSelectedCaseCount}
                onDirty={() => setHasUnfinishedWork(true)}
                onPublished={() => setHasUnfinishedWork(false)}
                analyticsRunId={state.data.analyticsRunId}
                itemsGenerated={state.data.testCases.length}
                itemsEdited={editedSelectedCaseCount}
              />
            </>
          ) : (
            <EmptyBlock message="No generated test cases yet. Return to Step 1 and run generation." />
          )}
        </div>
      )}
    </div>
  );
}

function TestDesignOptionsSelector({
  settings,
  customRangeValid,
  coverageFocusSelectionValid,
  onTargetRangeChange,
  onCustomRangeChange,
  onCoverageFocusToggle,
  onSelectAllCoverageFocus,
  onClearAllCoverageFocus,
}: {
  settings: TestDesignOptions;
  customRangeValid: boolean;
  coverageFocusSelectionValid: boolean;
  onTargetRangeChange: (targetTestCaseRange: TargetTestCaseRangeId) => void;
  onCustomRangeChange: (field: "customMinCases" | "customMaxCases", value: string) => void;
  onCoverageFocusToggle: (focusId: CoverageFocusId, checked: boolean) => void;
  onSelectAllCoverageFocus: () => void;
  onClearAllCoverageFocus: () => void;
}) {
  const selectedFocusIdSet = useMemo(() => new Set(settings.coverageFocusIds), [settings.coverageFocusIds]);
  const allSelected = settings.coverageFocusIds.length === allCoverageFocusIds.length;
  const noneSelected = settings.coverageFocusIds.length === 0;

  return (
    <div className="rounded-md border border-border bg-muted p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="space-y-3">
          <div>
            <div id="test-design-target-range-label" className="text-sm font-semibold text-foreground">Target Test Case Range</div>
            <NativeSelect
              containerClassName="mt-2"
              aria-labelledby="test-design-target-range-label"
              value={settings.targetTestCaseRange}
              onChange={(event) => onTargetRangeChange(event.target.value as TargetTestCaseRangeId)}
            >
              {targetTestCaseRangeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.id === "custom" ? option.label : `${option.label} (${option.minCases}-${option.maxCases})`}
                </option>
              ))}
            </NativeSelect>
          </div>

          {settings.targetTestCaseRange === "custom" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-muted-foreground">
                Minimum
                <Input
                  type="number"
                  min={1}
                  max={maxCustomTestCaseRange}
                  value={settings.customMinCases ?? ""}
                  onChange={(event) => onCustomRangeChange("customMinCases", event.target.value)}
                  aria-invalid={!customRangeValid}
                  aria-describedby={!customRangeValid ? "custom-range-error" : undefined}
                  className="mt-1"
                />
              </label>
              <label className="text-xs font-semibold text-muted-foreground">
                Maximum
                <Input
                  type="number"
                  min={1}
                  max={maxCustomTestCaseRange}
                  value={settings.customMaxCases ?? ""}
                  onChange={(event) => onCustomRangeChange("customMaxCases", event.target.value)}
                  aria-invalid={!customRangeValid}
                  aria-describedby={!customRangeValid ? "custom-range-error" : undefined}
                  className="mt-1"
                />
              </label>
            </div>
          ) : null}

          {!customRangeValid ? (
            <Callout tone="warning" role="status" id="custom-range-error">
              Custom range must be between 1 and {maxCustomTestCaseRange}, with minimum not greater than maximum.
            </Callout>
          ) : null}
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div id="coverage-focus-group-label" className="text-sm font-semibold text-foreground">Coverage Focus Rules</div>
              <div id="coverage-focus-count" className="text-xs tabular-nums text-muted-foreground">
                {settings.coverageFocusIds.length} of {allCoverageFocusIds.length} selected
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={onSelectAllCoverageFocus} disabled={allSelected} className="h-8 px-3 text-xs">
                Select all
              </Button>
              <Button variant="ghost" onClick={onClearAllCoverageFocus} disabled={noneSelected} className="h-8 px-3 text-xs">
                Clear all
              </Button>
            </div>
          </div>

          <div role="group" aria-labelledby="coverage-focus-group-label" aria-describedby="coverage-focus-count" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {coverageFocusOptions.map((focusItem) => {
              const checked = selectedFocusIdSet.has(focusItem.id);
              return (
                <label
                  key={focusItem.id}
                  className={cn(
                    "flex min-h-12 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm text-foreground transition-colors duration-ui hover:border-primary/30 hover:bg-accent",
                    checked ? "border-primary/40 bg-primary/5" : "border-border bg-card",
                  )}
                >
                  <Checkbox checked={checked} onCheckedChange={(value) => onCoverageFocusToggle(focusItem.id, value === true)} aria-label={focusItem.title} />
                  <span className="leading-5">{focusItem.title}</span>
                </label>
              );
            })}
          </div>

          {!coverageFocusSelectionValid ? (
            <Callout tone="warning" role="status">
              Select at least one Coverage Focus item to generate or prepare the external LLM prompt.
            </Callout>
          ) : null}
        </div>
      </div>
    </div>
  );
}
