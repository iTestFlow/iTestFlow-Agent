"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ListChecks, Loader2, Play, Radar, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { toneClass, type Tone } from "@/components/qa/tone";
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
  ErrorBlock,
  SectionCard,
  SuggestedAdditionsPublishResultSummary,
  ToneBadge,
  formatPercentage,
  normalizeTestCasePriority,
  postJson,
  projectWarning,
  scoreTone,
  scrollToNextStep,
  severityTone,
  useActiveProject,
} from "@/components/workflow/test-intelligence-shared";
import type {
  ApiState,
  ExistingReviewFinding,
  ExistingReviewInsight,
  ExistingReviewResult,
  ExistingLinkedTestCase,
  ExistingTraceabilityRow,
  GeneratedTestCase,
  ManualPromptDraft,
  SuggestedAdditionsPublishResult,
  WorkflowMode,
} from "@/components/workflow/test-intelligence-types";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH, normalizeExtraInstructions } from "@/modules/llm/extra-instructions";
import type { ActiveProjectScope } from "@/shared/lib/active-project";

export function TestGapAnalysisClient() {
  const scope = useActiveProject();
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const promptSectionRef = useRef<HTMLDivElement | null>(null);
  const [activeStep, setActiveStep] = useState<"analyze" | "review">("analyze");
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

  function changeTargetWorkItemId(value: string) {
    gen.cancel();
    prep.cancel();
    setActiveStep("analyze");
    setHasUnfinishedWork(true);
    setTargetWorkItemId(value);
    setState({ loading: false, error: null, data: null });
    setSelectedSuggestedIds([]);
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
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function applyReviewResult(data: ExistingReviewResult) {
    setActiveStep("review");
    setHasUnfinishedWork(data.suggestedAdditions.length > 0);
    setState({ loading: false, error: null, data });
    setSelectedSuggestedIds(data.suggestedAdditions.map((testCase) => testCase.id));
  }

  function updateSuggestedAdditions(testCases: GeneratedTestCase[]) {
    setHasUnfinishedWork(true);
    setState((current) => ({
      ...current,
      data: current.data ? { ...current.data, suggestedAdditions: testCases } : current.data,
    }));
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
            label: "Review Gaps & Publish Additions",
            description: "Inspect coverage and approve suggested test cases.",
            icon: ListChecks,
          },
        ]}
        activeStepId={activeStep}
        completedStepIds={state.data ? ["analyze"] : []}
        enabledStepIds={state.data ? ["analyze", "review"] : ["analyze"]}
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
        <div ref={resultsRef} className="space-y-6">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">
                Reviewing coverage gaps for #{targetWorkItemId}
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
          <div className="space-y-2">
            {mode === "auto" && gen.status === "completed" ? (
              <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} warnings={gen.warnings} />
            ) : null}
            <WorkflowContextCitations citations={state.data.contextCitations} />
            <ExistingTraceabilitySummary result={state.data} />
          </div>
          <ExistingTraceabilityMatrix rows={state.data.traceabilityMatrix} />
          <ExistingReviewInsights insights={state.data.insights} findings={state.data.findings} />
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
        </div>
      ) : null}
    </div>
  );
}

function ExistingTraceabilitySummary({ result }: { result: ExistingReviewResult }) {
  const counts = countTraceabilityStatuses(result.traceabilityMatrix);
  const gapCount = counts["Partially covered"] + counts["Not covered"] + counts["Needs review"];
  const metrics: Array<{ title: string; value: string; tone: Tone }> = [
    { title: "Coverage Score", value: formatPercentage(result.coverageScore), tone: scoreTone(result.coverageScore) },
    { title: "Coverage Points", value: String(result.traceabilityMatrix.length), tone: "primary" },
    { title: "Covered", value: String(counts.Covered), tone: "success" },
    { title: "Gaps", value: String(gapCount), tone: gapCount ? "error" : "success" },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        {metrics.map((metric) => (
          <CoverageMetric key={metric.title} label={metric.title} value={metric.value} tone={metric.tone} />
        ))}
      </div>
      <SectionCard>
        <div className="p-4">
          <div className="text-sm font-semibold text-foreground">Review Summary</div>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{result.summary}</p>
        </div>
      </SectionCard>
    </div>
  );
}

function CoverageMetric({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className={`rounded-md border p-4 ${toneClass[tone]}`}>
      <div className="text-base font-semibold text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function ExistingTraceabilityMatrix({ rows }: { rows: ExistingTraceabilityRow[] }) {
  return (
    <SectionCard
      title="Traceability Matrix"
      description="Every row is one atomic coverage point mapped to linked Azure DevOps test cases."
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
            <thead className="bg-muted text-xs uppercase tracking-normal text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-semibold">Point</th>
                <th className="px-4 py-3 font-semibold">Source</th>
                <th className="px-4 py-3 font-semibold">Requirement</th>
                <th className="px-4 py-3 font-semibold">Coverage</th>
                <th className="px-4 py-3 font-semibold">Linked Cases</th>
                <th className="px-4 py-3 font-semibold">Evidence</th>
                <th className="px-4 py-3 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-4">
                    <div className="font-mono text-xs font-semibold text-primary">{row.id}</div>
                    <ToneBadge tone={severityTone(row.severity)} className="mt-2">{row.severity}</ToneBadge>
                  </td>
                  <td className="px-4 py-4">
                    <div className="font-medium text-foreground">{coverageSourceLabel(row.sourceType)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{row.sourceReference}</div>
                  </td>
                  <td className="max-w-[320px] px-4 py-4 text-foreground">
                    <p className="break-words leading-6">{row.requirementText}</p>
                    {row.missingCoverage ? <p className="mt-2 text-xs leading-5 text-destructive">{row.missingCoverage}</p> : null}
                  </td>
                  <td className="px-4 py-4">
                    <ToneBadge tone={coverageTone(row.coverageStatus)}>{row.coverageStatus}</ToneBadge>
                    <div className="mt-2 text-xs text-muted-foreground">Min tests: {row.recommendedMinimumTestCount}</div>
                  </td>
                  <td className="px-4 py-4">
                    {row.linkedTestCaseIds.length ? (
                      <div className="flex max-w-[180px] flex-wrap gap-1">
                        {row.linkedTestCaseIds.map((id) => <ToneBadge key={id} tone="primary">{id}</ToneBadge>)}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">No linked case</span>
                    )}
                  </td>
                  <td className="max-w-[260px] px-4 py-4 text-muted-foreground">
                    <p className="break-words leading-6">{row.evidenceSummary || "No evidence supplied."}</p>
                  </td>
                  <td className="max-w-[260px] px-4 py-4 text-primary">
                    <p className="break-words leading-6">{row.recommendedAction}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyBlock message="No traceability rows were returned by the LLM." />
      )}
    </SectionCard>
  );
}

function ExistingReviewInsights({ insights, findings }: { insights: ExistingReviewInsight[]; findings: ExistingReviewFinding[] }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <SectionCard title="Coverage Insights">
        {insights.length ? (
          <div className="divide-y divide-border">
            {insights.map((insight) => (
              <div key={insight.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <ToneBadge tone={severityTone(insight.severity)}>{insight.severity}</ToneBadge>
                  <span className="font-medium text-foreground">{insight.title}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{insight.explanation}</p>
                <p className="mt-2 text-sm leading-6 text-primary">{insight.suggestedAction}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBlock message="No additional insights were returned." />
        )}
      </SectionCard>
      <SectionCard title="Review Findings">
        {findings.length ? (
          <div className="divide-y divide-border">
            {findings.map((finding) => (
              <div key={finding.id} className="grid gap-3 p-4 md:grid-cols-[120px_1fr]">
                <ToneBadge tone={severityTone(finding.severity)} className="self-start justify-self-start whitespace-nowrap">{finding.severity}</ToneBadge>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{finding.title}</span>
                    <ToneBadge tone="neutral">{finding.category}</ToneBadge>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{finding.explanation}</p>
                  <p className="mt-2 text-sm leading-6 text-primary">{finding.suggestedAction}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBlock message="No review findings were returned." />
        )}
      </SectionCard>
    </div>
  );
}

function ExistingLinkedTestCasesList({ linkedTestCases }: { linkedTestCases: ExistingLinkedTestCase[] }) {
  const [open, setOpen] = useState(false);

  return (
    <SectionCard
      title="Linked Test Cases from Azure DevOps"
      action={
        <Button
          type="button"
          variant="secondary"
          className="h-8 px-3"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? "Hide" : "Show"}
        </Button>
      }
    >
      {open && linkedTestCases.length ? (
        <div className="divide-y divide-border">
          {linkedTestCases.map((testCase) => (
            <div key={testCase.id} className="grid gap-3 p-4 md:grid-cols-[140px_1fr_120px]">
              <span className="font-mono text-xs text-primary">{testCase.id}</span>
              <div>
                <div className="font-medium text-foreground">{testCase.title}</div>
                <div className="mt-1 text-xs text-muted-foreground">{testCase.testType ?? "Test Case"}</div>
              </div>
              <span className="text-sm text-muted-foreground">{testCase.steps?.length ?? 0} steps</span>
            </div>
          ))}
        </div>
      ) : open ? (
        <EmptyBlock message="No TestedBy / Tests linked Azure DevOps test cases were found for this story." />
      ) : null}
    </SectionCard>
  );
}

function SuggestedAdditionsPublishPanel({
  scope,
  targetWorkItemId,
  testCases,
  invalidCaseCount,
  onPublished,
  analyticsRunId,
  itemsGenerated,
  itemsEdited,
}: {
  scope: ActiveProjectScope | null;
  targetWorkItemId: string;
  testCases: GeneratedTestCase[];
  invalidCaseCount: number;
  onPublished: () => void;
  analyticsRunId?: string;
  itemsGenerated: number;
  itemsEdited: number;
}) {
  const [state, setState] = useState<ApiState<SuggestedAdditionsPublishResult>>({ loading: false, error: null, data: null });
  useUnsavedChangesGuard({ dirty: false, busy: state.loading });

  async function publish() {
    if (!scope || !targetWorkItemId || !testCases.length || state.loading) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<SuggestedAdditionsPublishResult>("/api/test-coverage-matrix/suggested-additions/publish", {
        scope,
        analyticsRunId,
        itemsGenerated,
        itemsEdited,
        targetWorkItemId,
        testCases: testCases.map((testCase) => ({
          ...testCase,
          localId: testCase.id,
          targetUserStoryId: targetWorkItemId,
          priority: normalizeTestCasePriority(testCase.priority),
          steps: testCase.steps.map((step) => ({ action: step.action, expectedResult: step.expectedResult })),
          testType: testCase.type,
        })),
      });
      setState({ loading: false, error: null, data });
      if (data.results.length > 0 && data.results.every((result) => result.success)) {
        onPublished();
      }
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Suggested additions publish failed.", data: null });
    }
  }

  const disabled = !scope || !targetWorkItemId || !testCases.length || invalidCaseCount > 0 || state.loading;

  return (
    <SectionCard
      title="Add Suggested Additions to Azure"
      description="Create the suggested Azure Test Case work items and link them to the selected user story."
    >
      <div className="space-y-4 p-4">
        {state.error ? <ErrorBlock message={state.error} /> : null}
        {invalidCaseCount > 0 ? (
          <Callout tone="warning">
            Resolve validation issues in the {invalidCaseCount} selected suggested test case{invalidCaseCount === 1 ? "" : "s"} before creating them.
          </Callout>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm leading-6 text-muted-foreground">
            {testCases.length} suggested test case{testCases.length === 1 ? "" : "s"} will be created and linked to user story {targetWorkItemId || "the selected story"}.
          </div>
          <ConfirmationDialog
            trigger={
              <Button disabled={disabled}>
                {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {state.loading ? "Adding..." : "Add to Azure"}
              </Button>
            }
            title="Add suggested test cases to Azure?"
            description={
              <div className="space-y-1">
                <p>Project: {scope?.azureProjectName ?? "Selected Azure DevOps project"}</p>
                <p>User story: {targetWorkItemId}</p>
                <p>Suggested test cases: {testCases.length}</p>
                <p>Each created test case will be linked to this user story.</p>
              </div>
            }
            confirmLabel="Create and link cases"
            onConfirm={publish}
          />
        </div>
        {state.data ? <SuggestedAdditionsPublishResultSummary data={state.data} /> : null}
      </div>
    </SectionCard>
  );
}

function countTraceabilityStatuses(rows: ExistingTraceabilityRow[]) {
  return rows.reduce(
    (counts, row) => {
      counts[row.coverageStatus] += 1;
      return counts;
    },
    { Covered: 0, "Partially covered": 0, "Not covered": 0, "Needs review": 0 },
  );
}

function coverageTone(status: ExistingTraceabilityRow["coverageStatus"]): Tone {
  if (status === "Covered") return "success";
  if (status === "Partially covered") return "warning";
  if (status === "Not covered") return "error";
  return "draft";
}

function coverageSourceLabel(sourceType: ExistingTraceabilityRow["sourceType"]) {
  if (sourceType === "businessRules") return "Business Rules";
  if (sourceType === "acceptanceCriteria") return "Acceptance Criteria";
  if (sourceType === "description") return "Description";
  return "Story";
}
