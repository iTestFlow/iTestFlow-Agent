"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ListChecks, Play, Radar } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Callout } from "@/components/qa/callout";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress";
import { AiGenerationCompletedMetrics } from "@/components/workflow/ai-generation-metrics";
import { WorkflowContextCitations } from "@/components/workflow/workflow-context-citations";
import { useAiGeneration } from "@/components/workflow/use-ai-generation";
import { ExtraInstructionsField } from "@/components/workflow/extra-instructions-field";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import {
  GeneratedTestCasesReview,
  validateGeneratedTestCase,
} from "@/components/workflow/generated-test-cases-review";
import { WorkItemPreview, useWorkItemLookup, WORK_ITEM_ID_PLACEHOLDER, WORK_ITEM_ID_TITLE } from "@/components/workflow/work-item-loader";
import {
  EmptyBlock,
  SectionCard,
  postJson,
  projectWarning,
  scrollToNextStep,
  useActiveProject,
} from "@/components/workflow/test-intelligence-shared";
import type {
  ApiState,
  ExistingReviewResult,
  GeneratedTestCase,
  ManualPromptDraft,
  WorkflowMode,
} from "@/components/workflow/test-intelligence-types";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH, normalizeExtraInstructions } from "@/modules/llm/extra-instructions";

import { countTraceabilityStatuses } from "./lib/traceability-text";
import { ReviewMetrics } from "./components/review-metrics";
import { ReviewSummaryCard } from "./components/review-summary-card";
import { FindingsReviewQueue } from "./components/findings-review-queue";
import { TraceabilityMatrixSection } from "./components/traceability-matrix-section";
import { StickyReviewActionBar } from "./components/sticky-review-action-bar";
import { ExistingLinkedTestCasesList } from "./components/linked-test-cases-list";
import { SuggestedAdditionsPublishPanel } from "./components/suggested-additions-publish-panel";

type TestGapAnalysisStep = "analyze" | "review" | "linkedCases";
type ReviewTab = "findings" | "matrix";

export function TestGapAnalysisClient() {
  const scope = useActiveProject();
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const promptSectionRef = useRef<HTMLDivElement | null>(null);
  const traceabilityMatrixRef = useRef<HTMLDivElement | null>(null);
  const [activeStep, setActiveStep] = useState<TestGapAnalysisStep>("analyze");
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const workItemLookup = useWorkItemLookup({ scope, workItemId: targetWorkItemId });
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [state, setState] = useState<ApiState<ExistingReviewResult>>({ loading: false, error: null, data: null });
  const gen = useAiGeneration();
  const prep = useAiGeneration({ prepareMs: 400, buildPromptMs: 500 });
  const cancelGeneration = gen.cancel;
  const cancelPreparation = prep.cancel;
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [selectedSuggestedIds, setSelectedSuggestedIds] = useState<string[]>([]);
  const [focusedMatrixRowIds, setFocusedMatrixRowIds] = useState<string[]>([]);
  const [reviewTab, setReviewTab] = useState<ReviewTab>("findings");
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({
    dirty: hasUnfinishedWork,
    busy: state.loading || manualDraft.loading || manualSubmitLoading || gen.isRunning || prep.isRunning,
  });
  useEffect(() => {
    cancelGeneration();
    cancelPreparation();
    setActiveStep("analyze");
    setTargetWorkItemId("");
    setHasUnfinishedWork(false);
    setState({ loading: false, error: null, data: null });
    setSelectedSuggestedIds([]);
    setFocusedMatrixRowIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }, [scope?.azureProjectId, cancelGeneration, cancelPreparation]);
  const extraInstructionsValid = extraInstructions.length <= EXTRA_INSTRUCTIONS_MAX_LENGTH;
  const suggestedAdditions = useMemo(() => state.data?.suggestedAdditions ?? [], [state.data?.suggestedAdditions]);
  const selectedSuggestedAdditions = useMemo(() => {
    const selectedIds = new Set(selectedSuggestedIds);
    return suggestedAdditions.filter((testCase) => selectedIds.has(testCase.id));
  }, [selectedSuggestedIds, suggestedAdditions]);
  const invalidSelectedSuggestedCount = useMemo(
    () => selectedSuggestedAdditions.filter((testCase) => !validateGeneratedTestCase(testCase).valid).length,
    [selectedSuggestedAdditions],
  );
  const reviewGapCount = useMemo(() => {
    if (!state.data) return 0;
    const counts = countTraceabilityStatuses(state.data.traceabilityMatrix);
    return counts["Partially covered"] + counts["Not covered"] + counts["Needs review"];
  }, [state.data]);

  function changeTargetWorkItemId(value: string) {
    gen.cancel();
    prep.cancel();
    setActiveStep("analyze");
    setHasUnfinishedWork(true);
    setTargetWorkItemId(value);
    setState({ loading: false, error: null, data: null });
    setSelectedSuggestedIds([]);
    setFocusedMatrixRowIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeExtraInstructions(value: string) {
    gen.cancel();
    prep.cancel();
    setActiveStep("analyze");
    setHasUnfinishedWork(true);
    setExtraInstructions(value);
    setState({ loading: false, error: null, data: null });
    setSelectedSuggestedIds([]);
    setFocusedMatrixRowIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function applyReviewResult(data: ExistingReviewResult) {
    setActiveStep("review");
    setReviewTab("findings");
    setHasUnfinishedWork(data.suggestedAdditions.length > 0);
    setState({ loading: false, error: null, data });
    setSelectedSuggestedIds(data.suggestedAdditions.map((testCase) => testCase.id));
    setFocusedMatrixRowIds([]);
  }

  function updateSuggestedAdditions(testCases: GeneratedTestCase[]) {
    setHasUnfinishedWork(true);
    setState((current) => ({
      ...current,
      data: current.data ? { ...current.data, suggestedAdditions: testCases } : current.data,
    }));
  }

  function viewAffectedMatrixRows(rowIds: string[]) {
    const uniqueRowIds = Array.from(new Set(rowIds.filter((id) => id.trim().length > 0)));
    if (!uniqueRowIds.length) return;
    setActiveStep("review");
    setReviewTab("matrix");
    setFocusedMatrixRowIds(uniqueRowIds);
    window.setTimeout(() => {
      traceabilityMatrixRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  function changeReviewTab(tab: ReviewTab) {
    // A manual tab switch should drop any "affected rows" focus carried over
    // from a "View affected rows" jump so the matrix shows the full set again.
    setFocusedMatrixRowIds([]);
    setReviewTab(tab);
  }

  async function review() {
    if (!scope || !targetWorkItemId || !extraInstructionsValid) return;
    if (gen.isRunning) return;
    setState({ loading: true, error: null, data: null });
    setSelectedSuggestedIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    const data = await gen.start((signal) =>
      postJson<ExistingReviewResult>(
        "/api/existing-test-case-review/run",
        { scope, targetWorkItemId, extraInstructions: normalizeExtraInstructions(extraInstructions) },
        signal,
      ),
    );
    if (data) {
      applyReviewResult(data);
      scrollToNextStep(resultsRef);
    } else {
      setState({ loading: false, error: null, data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !extraInstructionsValid) return;
    if (prep.isRunning) return;
    setState({ loading: false, error: null, data: null });
    setSelectedSuggestedIds([]);
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    scrollToNextStep(promptSectionRef);
    const data = await prep.start((signal) =>
      postJson<ManualPromptDraft>(
        "/api/existing-test-case-review/manual/draft",
        { scope, targetWorkItemId, extraInstructions: normalizeExtraInstructions(extraInstructions) },
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
      const data = await postJson<ExistingReviewResult>("/api/existing-test-case-review/manual/submit", {
        scope,
        targetWorkItemId,
        rawOutput: manualResponse,
        selectedContextIds: manualDraft.data.selectedContextIds ?? [],
        resolvedContextUsed: manualDraft.data.resolvedContextUsed ?? [],
        contextCitations: manualDraft.data.contextCitations,
        retrievalTopK: manualDraft.data.retrievalTopK,
      });
      applyReviewResult(data);
      scrollToNextStep(resultsRef);
    } catch (error) {
      setManualSubmitError(error instanceof Error ? error.message : "External LLM response validation failed.");
    } finally {
      setManualSubmitLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <WorkflowStepper
        steps={[
          {
            id: "analyze",
            label: "Analyze Linked Test Coverage",
            description: "Load the story, linked tests, and project context.",
            icon: Radar,
          },
          {
            id: "review",
            label: "Review Gaps",
            description: "Inspect coverage gaps, traceability, and review findings.",
            icon: ListChecks,
          },
          {
            id: "linkedCases",
            label: "Linked Cases & Additions",
            description: "Review linked Azure DevOps test cases and approve suggested additions.",
            icon: ListChecks,
          },
        ]}
        activeStepId={activeStep}
        completedStepIds={state.data ? (activeStep === "linkedCases" ? ["analyze", "review"] : ["analyze"]) : []}
        enabledStepIds={state.data ? ["analyze", "review", "linkedCases"] : ["analyze"]}
        onStepChange={setActiveStep}
        ariaLabel="Test Gap Analysis workflow"
      />

      {activeStep === "analyze" ? (
        <div className="space-y-6">
          <SectionCard
            title="Analyze Linked Test Coverage"
            description="Enter a user story ID. Linked test cases and project context are selected automatically for this run."
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
                  <Label htmlFor="test-coverage-matrix-work-item-id" className="text-sm font-semibold text-foreground">
                    {WORK_ITEM_ID_TITLE}
                  </Label>
                  <Input
                    id="test-coverage-matrix-work-item-id"
                    value={targetWorkItemId}
                    inputMode="numeric"
                    onChange={(event) => changeTargetWorkItemId(event.target.value)}
                    placeholder={WORK_ITEM_ID_PLACEHOLDER}
                    title={WORK_ITEM_ID_TITLE}
                    aria-label={WORK_ITEM_ID_TITLE}
                  />
                </div>
                {mode === "auto" ? (
                  <Button onClick={review} disabled={!scope || !targetWorkItemId || gen.isRunning || !extraInstructionsValid}>
                    <Play className="h-4 w-4" />
                    {gen.isRunning ? "Reviewing..." : "Analyze Coverage"}
                  </Button>
                ) : (
                  <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || prep.isRunning || !extraInstructionsValid}>
                    <Play className="h-4 w-4" />
                    {prep.isRunning ? "Preparing..." : "Prepare Prompt"}
                  </Button>
                )}
              </div>
              <WorkItemPreview scope={scope} workItemId={targetWorkItemId} lookup={workItemLookup} />
              <ExtraInstructionsField value={extraInstructions} onChange={changeExtraInstructions} />
            </div>
          </SectionCard>

          <div ref={promptSectionRef} className="scroll-mt-4 space-y-4">
            {mode === "manual" && prep.status !== "idle" && prep.status !== "completed" ? (
              <AiGenerationProgress
                mode="prep"
                variant="coverage"
                status={prep.status}
                elapsedSeconds={prep.elapsedSeconds}
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
                {manualSubmitError ? <Callout tone="error">{manualSubmitError}</Callout> : null}
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

          {gen.status !== "idle" && gen.status !== "completed" ? (
            <AiGenerationProgress
              variant="coverage"
              status={gen.status}
              elapsedSeconds={gen.elapsedSeconds}
              errorMessage={gen.errorMessage}
              canCancel
              onCancel={gen.cancel}
              onRetry={() => {
                gen.retry();
                void review();
              }}
            />
          ) : null}
        </div>
      ) : state.data ? (
        <div ref={resultsRef} className="space-y-6 pb-24">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">
                {activeStep === "linkedCases" ? "Reviewing linked cases and additions" : "Reviewing coverage gaps"} for #{targetWorkItemId}
                {workItemLookup.data?.title ? (
                  <span className="font-normal text-muted-foreground"> — {workItemLookup.data.title}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">Coverage results remain available while you revisit the analysis input.</div>
            </div>
            <Button type="button" variant="outline" onClick={() => setActiveStep("analyze")}>
              <ArrowLeft className="size-4" />
              Back to inputs
            </Button>
          </div>
          {activeStep === "review" ? (
            <>
              <div className="space-y-3">
                {mode === "auto" && gen.status === "completed" ? (
                  <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} warnings={gen.warnings} />
                ) : null}
                <WorkflowContextCitations citations={state.data.contextCitations} />
                <ReviewMetrics result={state.data} />
                <ReviewSummaryCard summary={state.data.summary} />
              </div>
              <Tabs value={reviewTab} onValueChange={(value) => changeReviewTab(value as ReviewTab)} className="w-full flex-col gap-4">
                <TabsList variant="primary" className="grid h-auto w-full grid-cols-2 sm:inline-grid sm:w-fit sm:min-w-[420px]">
                  <TabsTrigger value="findings" className="h-10 px-3 py-2">
                    Findings Review
                    <span className="ml-1.5 text-xs opacity-80">({state.data.findings.length + state.data.insights.length})</span>
                  </TabsTrigger>
                  <TabsTrigger value="matrix" className="h-10 px-3 py-2">
                    Traceability Matrix
                    <span className="ml-1.5 text-xs opacity-80">({state.data.traceabilityMatrix.length})</span>
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="findings">
                  <FindingsReviewQueue
                    findings={state.data.findings}
                    insights={state.data.insights}
                    onViewAffectedRows={viewAffectedMatrixRows}
                  />
                </TabsContent>
                <TabsContent value="matrix">
                  <div ref={traceabilityMatrixRef} className="scroll-mt-4">
                    <TraceabilityMatrixSection
                      rows={state.data.traceabilityMatrix}
                      affectedRowIds={focusedMatrixRowIds}
                      onClearAffectedRows={() => setFocusedMatrixRowIds([])}
                    />
                  </div>
                </TabsContent>
              </Tabs>
              <StickyReviewActionBar
                findingCount={state.data.findings.length}
                gapCount={reviewGapCount}
                recommendationCount={state.data.suggestedAdditions.length}
                onReview={() => setActiveStep("linkedCases")}
              />
            </>
          ) : null}
          {activeStep === "linkedCases" ? (
            <>
              <ExistingLinkedTestCasesList linkedTestCases={state.data.linkedTestCases} />
              {state.data.suggestedAdditions.length ? (
                <>
                  <GeneratedTestCasesReview
                    testCases={state.data.suggestedAdditions}
                    onChange={updateSuggestedAdditions}
                    selectedIds={selectedSuggestedIds}
                    onSelectedIdsChange={(ids) => {
                      setHasUnfinishedWork(true);
                      setSelectedSuggestedIds(ids);
                    }}
                    title="Suggested Additions"
                    description="Review missing-coverage recommendations and create only the selected, approved additions."
                    allowAdd={false}
                    allowDelete
                  />
                  <SuggestedAdditionsPublishPanel
                    scope={scope}
                    targetWorkItemId={targetWorkItemId}
                    testCases={selectedSuggestedAdditions}
                    invalidCaseCount={invalidSelectedSuggestedCount}
                    onPublished={() => setHasUnfinishedWork(false)}
                    analyticsRunId={state.data.analyticsRunId}
                    itemsGenerated={state.data.suggestedAdditions.length}
                    itemsEdited={selectedSuggestedAdditions.filter((testCase) => {
                      const original = state.data?.suggestedAdditions.find((item) => item.id === testCase.id);
                      return JSON.stringify(testCase) !== JSON.stringify(original);
                    }).length}
                  />
                </>
              ) : (
                <EmptyBlock message="No draft additions were suggested. The current linked test cases may already cover the reviewed points, or only clarification is needed." />
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
