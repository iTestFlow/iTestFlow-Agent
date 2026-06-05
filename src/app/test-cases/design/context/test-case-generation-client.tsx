"use client";

import { useMemo, useRef, useState } from "react";
import { Play } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Callout } from "@/components/qa/callout";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { ExtraInstructionsField } from "@/components/workflow/extra-instructions-field";
import { WorkItemPreview, WORK_ITEM_ID_PLACEHOLDER, WORK_ITEM_ID_TITLE } from "@/components/workflow/work-item-loader";
import {
  EditableGeneratedCases,
  EmptyBlock,
  ErrorBlock,
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

export function TestCaseGenerationClient() {
  const scope = useActiveProject();
  const generatedCasesRef = useRef<HTMLDivElement | null>(null);
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [state, setState] = useState<ApiState<TestCaseGenerationRunResult>>({ loading: false, error: null, data: null });
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);
  const [testDesignSettings, setTestDesignSettings] = useState<TestDesignOptions>(() => ({
    ...defaultTestDesignOptions,
    coverageFocusIds: [...defaultTestDesignOptions.coverageFocusIds],
  }));
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

  function changeTargetWorkItemId(value: string) {
    setTargetWorkItemId(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeExtraInstructions(value: string) {
    setExtraInstructions(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function resetManualDraftForTestDesignOptionsChange() {
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeTargetTestCaseRange(targetTestCaseRange: TargetTestCaseRangeId) {
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
    const parsed = value ? Number(value) : undefined;
    setTestDesignSettings((current) => ({
      ...current,
      [field]: Number.isFinite(parsed) ? parsed : undefined,
    }));
    resetManualDraftForTestDesignOptionsChange();
  }

  function changeCoverageFocusSelection(focusId: CoverageFocusId, checked: boolean) {
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
    setTestDesignSettings((current) => ({ ...current, coverageFocusIds: [...allCoverageFocusIds] }));
    resetManualDraftForTestDesignOptionsChange();
  }

  function clearAllCoverageFocusItems() {
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
    setState({ loading: false, error: null, data });
    setTestCases(data.testCases);
  }

  async function generate() {
    if (!scope || !targetWorkItemId || !testDesignOptionsValid || !extraInstructionsValid) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<TestCaseGenerationRunResult>("/api/test-cases/generate", {
        scope,
        targetWorkItemId,
        options: buildTestDesignOptionsRequest(),
        extraInstructions: normalizeExtraInstructions(extraInstructions),
      });
      applyGeneratedCases(data);
      scrollToNextStep(generatedCasesRef);
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Test case generation failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !testDesignOptionsValid || !extraInstructionsValid) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/test-cases/manual/draft", {
        scope,
        targetWorkItemId,
        options: buildTestDesignOptionsRequest(),
        extraInstructions: normalizeExtraInstructions(extraInstructions),
      });
      setManualDraft({ loading: false, error: null, data });
    } catch (error) {
      setManualDraft({ loading: false, error: error instanceof Error ? error.message : "External LLM prompt preparation failed.", data: null });
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
        retrievalTopK: manualDraft.data.retrievalTopK,
      });
      applyGeneratedCases(data);
      scrollToNextStep(generatedCasesRef);
    } catch (error) {
      setManualSubmitError(error instanceof Error ? error.message : "External LLM response validation failed.");
    } finally {
      setManualSubmitLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <SectionCard
        title="Generate Test Cases from Azure DevOps Requirement"
        description="Project context is selected automatically for this run."
        action={<GenerationModeToggle mode={mode} onChange={setMode} />}
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
              <Button onClick={generate} disabled={!scope || !targetWorkItemId || state.loading || !testDesignOptionsValid || !extraInstructionsValid}>
                <Play className="h-4 w-4" />
                {state.loading ? "Generating..." : "Generate"}
              </Button>
            ) : (
              <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || manualDraft.loading || !testDesignOptionsValid || !extraInstructionsValid}>
                <Play className="h-4 w-4" />
                {manualDraft.loading ? "Preparing..." : "Prepare Prompt"}
              </Button>
            )}
          </div>
          <WorkItemPreview scope={scope} workItemId={targetWorkItemId} />
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

      {mode === "manual" && (manualDraft.data || manualDraft.error || manualSubmitError) ? (
        <div className="space-y-4">
          {(manualDraft.error ?? manualSubmitError) ? <Callout tone="error">{manualDraft.error ?? manualSubmitError}</Callout> : null}
          {manualDraft.data ? (
            <ManualLLMPanel
              prompt={manualDraft.data.prompt}
              promptVersion={manualDraft.data.promptVersion}
              response={manualResponse}
              onResponseChange={setManualResponse}
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

      {state.error ? <ErrorBlock message={state.error} /> : null}
      <div ref={generatedCasesRef} className="space-y-6">
        {state.data || testCases.length ? (
          <>
            <EditableGeneratedCases testCases={testCases} setTestCases={setTestCases} />
            <PublishGeneratedCasesPanel scope={scope} targetWorkItemId={targetWorkItemId} testCases={testCases} />
          </>
        ) : (
          <EmptyBlock message="No generated test cases yet. Run generation against a real Azure DevOps work item." />
        )}
      </div>
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
            <div className="text-sm font-semibold text-foreground">Target Test Case Range</div>
            <div className="mt-2">
              <select
                className="focus-ring h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                value={settings.targetTestCaseRange}
                onChange={(event) => onTargetRangeChange(event.target.value as TargetTestCaseRangeId)}
              >
                {targetTestCaseRangeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id === "custom" ? option.label : `${option.label} (${option.minCases}-${option.maxCases})`}
                  </option>
                ))}
              </select>
            </div>
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
                  className="mt-1"
                />
              </label>
            </div>
          ) : null}

          {!customRangeValid ? (
            <div className="rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-foreground">
              Custom range must be between 1 and {maxCustomTestCaseRange}, with minimum not greater than maximum.
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">Coverage Focus Rules</div>
              <div className="text-xs text-muted-foreground">
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

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {coverageFocusOptions.map((focusItem) => {
              const checked = selectedFocusIdSet.has(focusItem.id);
              return (
                <label
                  key={focusItem.id}
                  className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition hover:border-primary/30 hover:bg-accent"
                >
                  <Checkbox checked={checked} onCheckedChange={(value) => onCoverageFocusToggle(focusItem.id, value === true)} aria-label={focusItem.title} />
                  <span className="leading-5">{focusItem.title}</span>
                </label>
              );
            })}
          </div>

          {!coverageFocusSelectionValid ? (
            <div className="mt-3 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-foreground">
              Select at least one Coverage Focus item to generate or prepare the external LLM prompt.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
