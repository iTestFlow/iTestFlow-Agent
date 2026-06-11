"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CheckCircle2, FileSearch, ListChecks, Loader2, Play, Send, X } from "lucide-react";

import { Badge as UiBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProjectUserPicker, projectUserLabel } from "@/components/domain/project-user-picker";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress";
import { AiGenerationCompletedMetrics } from "@/components/workflow/ai-generation-metrics";
import { WorkflowContextCitations } from "@/components/workflow/workflow-context-citations";
import { useAiGeneration } from "@/components/workflow/use-ai-generation";
import { ExtraInstructionsField } from "@/components/workflow/extra-instructions-field";
import { WorkflowStepper } from "@/components/workflow/workflow-stepper";
import {
  RequirementFindingsReview,
  validateRequirementFinding,
} from "@/components/workflow/requirement-findings-review";
import { WorkItemPreview, useWorkItemLookup, WORK_ITEM_ID_PLACEHOLDER, WORK_ITEM_ID_TITLE } from "@/components/workflow/work-item-loader";
import {
  ErrorBlock,
  SectionCard,
  postJson,
  projectWarning,
  scrollToNextStep,
  useActiveProject,
} from "@/components/workflow/test-intelligence-shared";
import type {
  ApiState,
  ManualPromptDraft,
  RequirementAnalysisRunResult,
  RequirementFinding,
  WorkflowMode,
} from "@/components/workflow/test-intelligence-types";
import {
  allRequirementAnalysisChecklistItemIds,
  requirementAnalysisChecklistOptions,
  type RequirementAnalysisChecklistItemId,
} from "@/modules/requirement-analysis/checklist-options";
import { buildRequirementAnalysisComment } from "@/modules/requirement-analysis/comment/requirement-analysis-comment";
import { EXTRA_INSTRUCTIONS_MAX_LENGTH, normalizeExtraInstructions } from "@/modules/llm/extra-instructions";
import type { ProjectUser } from "@/types/azure-devops";

function severityRank(value: RequirementFinding["severity"]) {
  const ranks: Record<RequirementFinding["severity"], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
  };
  return ranks[value] ?? 5;
}

function buildCommentBodyWithMentions(commentBody: string, mentionedUsers: ProjectUser[]) {
  if (!mentionedUsers.length) return commentBody;
  const mentionLine = mentionedUsers.map((user) => `@<${user.id}>`).join(" ");
  return `${mentionLine}\n\n${commentBody.trim()}`;
}

export function RequirementsAnalysisClient() {
  const scope = useActiveProject();
  const findingsCardRef = useRef<HTMLDivElement | null>(null);
  const [activeStep, setActiveStep] = useState<"analyze" | "review">("analyze");
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const workItemLookup = useWorkItemLookup({ scope, workItemId: targetWorkItemId });
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [extraInstructions, setExtraInstructions] = useState("");
  const [enabledChecklistItemIds, setEnabledChecklistItemIds] = useState<RequirementAnalysisChecklistItemId[]>(() => [...allRequirementAnalysisChecklistItemIds]);
  const [analysis, setAnalysis] = useState<ApiState<RequirementAnalysisRunResult>>({
    loading: false,
    error: null,
    data: null,
  });
  const gen = useAiGeneration();
  const prep = useAiGeneration({ prepareMs: 400, buildPromptMs: 500 });
  const cancelGeneration = gen.cancel;
  const cancelPreparation = prep.cancel;
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [findings, setFindings] = useState<RequirementFinding[]>([]);
  const [selectedFindingIds, setSelectedFindingIds] = useState<string[]>([]);
  const [findingsReviewVersion, setFindingsReviewVersion] = useState(0);
  const [pushState, setPushState] = useState<ApiState<{ success: boolean }>>({ loading: false, error: null, data: null });
  const [projectUsersState, setProjectUsersState] = useState<ApiState<ProjectUser[]>>({ loading: false, error: null, data: [] });
  const [selectedMentionUserIds, setSelectedMentionUserIds] = useState<string[]>([]);
  const [hasUnfinishedWork, setHasUnfinishedWork] = useState(false);
  useUnsavedChangesGuard({
    dirty: hasUnfinishedWork,
    busy:
      analysis.loading ||
      manualDraft.loading ||
      manualSubmitLoading ||
      pushState.loading ||
      gen.isRunning ||
      prep.isRunning,
  });
  useEffect(() => {
    cancelGeneration();
    cancelPreparation();
    setActiveStep("analyze");
    setTargetWorkItemId("");
    setHasUnfinishedWork(false);
    setAnalysis({ loading: false, error: null, data: null });
    setFindings([]);
    setSelectedFindingIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    setPushState({ loading: false, error: null, data: null });
    setSelectedMentionUserIds([]);
  }, [scope?.azureProjectId, cancelGeneration, cancelPreparation]);
  const sortedFindingList = useMemo(
    () => [...findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity)),
    [findings],
  );
  const selectedFindingList = useMemo(
    () => {
      const selectedIds = new Set(selectedFindingIds);
      return sortedFindingList.filter((finding) => selectedIds.has(finding.id));
    },
    [selectedFindingIds, sortedFindingList],
  );
  const invalidSelectedFindingCount = useMemo(
    () => selectedFindingList.filter((finding) => !validateRequirementFinding(finding).valid).length,
    [selectedFindingList],
  );
  const projectUsers = useMemo(() => projectUsersState.data ?? [], [projectUsersState.data]);
  const selectedMentionUsers = useMemo(() => {
    const selectedIds = new Set(selectedMentionUserIds);
    return projectUsers.filter((user) => selectedIds.has(user.id));
  }, [projectUsers, selectedMentionUserIds]);
  const checklistSelectionValid = enabledChecklistItemIds.length > 0;
  const extraInstructionsValid = extraInstructions.length <= EXTRA_INSTRUCTIONS_MAX_LENGTH;

  useEffect(() => {
    setSelectedMentionUserIds([]);
    setProjectUsersState({ loading: Boolean(scope), error: null, data: [] });
    if (!scope) return;

    let cancelled = false;
    void postJson<{ users: ProjectUser[] }>("/api/azure-devops/project-users", { scope })
      .then((data) => {
        if (cancelled) return;
        setProjectUsersState({ loading: false, error: null, data: data.users ?? [] });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProjectUsersState({
          loading: false,
          error: error instanceof Error ? error.message : "Azure DevOps project user fetch failed.",
          data: [],
        });
      });

    return () => {
      cancelled = true;
    };
  }, [scope]);

  function changeTargetWorkItemId(value: string) {
    gen.cancel();
    prep.cancel();
    setActiveStep("analyze");
    setHasUnfinishedWork(true);
    setTargetWorkItemId(value);
    setAnalysis({ loading: false, error: null, data: null });
    setFindings([]);
    setSelectedFindingIds([]);
    setFindingsReviewVersion((current) => current + 1);
    setPushState({ loading: false, error: null, data: null });
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    setSelectedMentionUserIds([]);
  }

  function changeExtraInstructions(value: string) {
    gen.cancel();
    prep.cancel();
    setActiveStep("analyze");
    setHasUnfinishedWork(true);
    setExtraInstructions(value);
    setAnalysis({ loading: false, error: null, data: null });
    setFindings([]);
    setSelectedFindingIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function resetManualDraftForChecklistChange() {
    gen.cancel();
    prep.cancel();
    setActiveStep("analyze");
    setAnalysis({ loading: false, error: null, data: null });
    setFindings([]);
    setSelectedFindingIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeChecklistSelection(checklistItemId: RequirementAnalysisChecklistItemId, checked: boolean) {
    setHasUnfinishedWork(true);
    setEnabledChecklistItemIds((current) => {
      const nextIds = new Set(current);
      if (checked) {
        nextIds.add(checklistItemId);
      } else {
        nextIds.delete(checklistItemId);
      }
      return allRequirementAnalysisChecklistItemIds.filter((id) => nextIds.has(id));
    });
    resetManualDraftForChecklistChange();
  }

  function selectAllChecklistItems() {
    setHasUnfinishedWork(true);
    setEnabledChecklistItemIds([...allRequirementAnalysisChecklistItemIds]);
    resetManualDraftForChecklistChange();
  }

  function clearAllChecklistItems() {
    setHasUnfinishedWork(true);
    setEnabledChecklistItemIds([]);
    resetManualDraftForChecklistChange();
  }

  function applyAnalysisResult(data: RequirementAnalysisRunResult) {
    setActiveStep("review");
    setHasUnfinishedWork(data.findings.length > 0);
    setAnalysis({ loading: false, error: null, data });
    setFindings(data.findings);
    setSelectedFindingIds(data.findings.map((finding) => finding.id));
    setFindingsReviewVersion((current) => current + 1);
    setPushState({ loading: false, error: null, data: null });
    setSelectedMentionUserIds([]);
  }

  async function runAnalysis() {
    if (!scope || !targetWorkItemId || !checklistSelectionValid || !extraInstructionsValid) return;
    if (gen.isRunning) return;
    setAnalysis({ loading: true, error: null, data: null });
    setFindings([]);
    setSelectedFindingIds([]);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    const data = await gen.start((signal) =>
      postJson<RequirementAnalysisRunResult>(
        "/api/requirement-analysis/run",
        { scope, targetWorkItemId, enabledChecklistItemIds, extraInstructions: normalizeExtraInstructions(extraInstructions) },
        signal,
      ),
    );
    if (data) {
      applyAnalysisResult(data);
      scrollToNextStep(findingsCardRef);
    } else {
      // cancelled or failed: the progress panel owns the message.
      setAnalysis({ loading: false, error: null, data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !checklistSelectionValid || !extraInstructionsValid) return;
    if (prep.isRunning) return;
    setAnalysis({ loading: false, error: null, data: null });
    setFindings([]);
    setSelectedFindingIds([]);
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    const data = await prep.start((signal) =>
      postJson<ManualPromptDraft>(
        "/api/requirement-analysis/manual/draft",
        { scope, targetWorkItemId, enabledChecklistItemIds, extraInstructions: normalizeExtraInstructions(extraInstructions) },
        signal,
      ),
    );
    if (data) {
      setManualDraft({ loading: false, error: null, data });
    } else {
      setManualDraft({ loading: false, error: null, data: null });
    }
  }

  async function submitManualResponse() {
    if (!scope || !targetWorkItemId || !manualDraft.data || !manualResponse.trim()) return;
    setManualSubmitLoading(true);
    setManualSubmitError(null);
    try {
      const data = await postJson<RequirementAnalysisRunResult>("/api/requirement-analysis/manual/submit", {
        scope,
        targetWorkItemId,
        rawOutput: manualResponse,
        enabledChecklistItemIds: manualDraft.data.enabledChecklistItemIds ?? enabledChecklistItemIds,
        selectedContextIds: manualDraft.data.selectedContextIds ?? [],
        resolvedContextUsed: manualDraft.data.resolvedContextUsed ?? [],
        contextCitations: manualDraft.data.contextCitations,
        retrievalTopK: manualDraft.data.retrievalTopK,
      });
      applyAnalysisResult(data);
      scrollToNextStep(findingsCardRef);
    } catch (error) {
      setManualSubmitError(error instanceof Error ? error.message : "External LLM response validation failed.");
    } finally {
      setManualSubmitLoading(false);
    }
  }

  function buildCommentBody() {
    if (!scope || !targetWorkItemId || !analysis.data) return;
    return buildRequirementAnalysisComment({
      workItemId: targetWorkItemId,
      summary: analysis.data.summary,
      findings: selectedFindingList,
    });
  }

  function changeFindings(nextFindings: RequirementFinding[]) {
    setHasUnfinishedWork(true);
    setFindings(nextFindings);
    setPushState({ loading: false, error: null, data: null });
  }

  function changeSelectedFindingIds(ids: string[]) {
    setHasUnfinishedWork(true);
    setSelectedFindingIds(ids);
    setPushState({ loading: false, error: null, data: null });
  }

  function changeMentionUsers(userIds: string[]) {
    setHasUnfinishedWork(true);
    setSelectedMentionUserIds(userIds);
    setPushState({ loading: false, error: null, data: null });
  }

  async function pushComment() {
    const commentBody = buildCommentBody();
    if (
      !scope ||
      !targetWorkItemId ||
      !analysis.data ||
      !selectedFindingList.length ||
      invalidSelectedFindingCount > 0 ||
      !commentBody ||
      pushState.data?.success
    ) return;
    setPushState({ loading: true, error: null, data: null });
    try {
      await postJson("/api/requirement-analysis/comment", {
        scope,
        targetWorkItemId,
        selectedFindingIds: selectedFindingList.map((finding) => finding.id),
        commentBody: buildCommentBodyWithMentions(commentBody, selectedMentionUsers),
        mentionedUsers: selectedMentionUsers.map((user) => ({
          id: user.id,
          displayName: user.displayName,
          uniqueName: user.uniqueName,
        })),
      });
      setPushState({ loading: false, error: null, data: { success: true } });
      setHasUnfinishedWork(false);
    } catch (error) {
      setPushState({ loading: false, error: error instanceof Error ? error.message : "Azure DevOps comment push failed.", data: null });
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <WorkflowStepper
        steps={[
          {
            id: "analyze",
            label: "Analyze Requirement",
            description: "Choose the requirement and analysis checklist.",
            icon: FileSearch,
          },
          {
            id: "review",
            label: "Review & Publish Findings",
            description: "Refine findings and publish the approved comment.",
            icon: ListChecks,
          },
        ]}
        activeStepId={activeStep}
        completedStepIds={analysis.data ? ["analyze"] : []}
        enabledStepIds={analysis.data ? ["analyze", "review"] : ["analyze"]}
        onStepChange={setActiveStep}
        ariaLabel="Requirements Analysis workflow"
      />

      {activeStep === "analyze" ? (
        <div className="space-y-6">
          <SectionCard
            title="Analyze Azure DevOps Requirement"
            description="Enter a real Azure DevOps work item ID. Project context is selected automatically for this run."
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
                  <Label htmlFor="requirement-analysis-work-item-id" className="text-sm font-semibold text-foreground">
                    {WORK_ITEM_ID_TITLE}
                  </Label>
                  <Input
                    id="requirement-analysis-work-item-id"
                    value={targetWorkItemId}
                    inputMode="numeric"
                    onChange={(event) => changeTargetWorkItemId(event.target.value)}
                    placeholder={WORK_ITEM_ID_PLACEHOLDER}
                    title={WORK_ITEM_ID_TITLE}
                    aria-label={WORK_ITEM_ID_TITLE}
                  />
                </div>
                {mode === "auto" ? (
                  <Button onClick={runAnalysis} disabled={!scope || !targetWorkItemId || gen.isRunning || !checklistSelectionValid || !extraInstructionsValid}>
                    <Play className="h-4 w-4" />
                    {gen.isRunning ? "Analyzing..." : "Analyze"}
                  </Button>
                ) : (
                  <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || prep.isRunning || !checklistSelectionValid || !extraInstructionsValid}>
                    <Play className="h-4 w-4" />
                    {prep.isRunning ? "Preparing..." : "Prepare Prompt"}
                  </Button>
                )}
              </div>
              <WorkItemPreview scope={scope} workItemId={targetWorkItemId} lookup={workItemLookup} />
              <ExtraInstructionsField value={extraInstructions} onChange={changeExtraInstructions} />
              <RequirementChecklistSelector
                selectedIds={enabledChecklistItemIds}
                onToggle={changeChecklistSelection}
                onSelectAll={selectAllChecklistItems}
                onClearAll={clearAllChecklistItems}
              />
            </div>
          </SectionCard>

          {mode === "manual" && prep.status !== "idle" && prep.status !== "completed" ? (
            <AiGenerationProgress
              mode="prep"
              variant="analysis"
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

          {gen.status !== "idle" && gen.status !== "completed" ? (
            <AiGenerationProgress
              variant="analysis"
              status={gen.status}
              elapsedSeconds={gen.elapsedSeconds}
              errorMessage={gen.errorMessage}
              canCancel
              onCancel={gen.cancel}
              onRetry={() => {
                gen.retry();
                void runAnalysis();
              }}
            />
          ) : null}
        </div>
      ) : analysis.data ? (
        <div ref={findingsCardRef} className="space-y-3">
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">
                Reviewing analysis findings for #{targetWorkItemId}
                {workItemLookup.data?.title ? (
                  <span className="font-normal text-muted-foreground"> — {workItemLookup.data.title}</span>
                ) : null}
              </div>
              <div className="text-xs text-muted-foreground">Your generated findings remain available when you return to the checklist.</div>
            </div>
            <Button type="button" variant="outline" onClick={() => setActiveStep("analyze")}>
              <ArrowLeft className="size-4" />
              Back to inputs
            </Button>
          </div>
          {mode === "auto" && gen.status === "completed" ? (
            <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} warnings={gen.warnings} />
          ) : null}
          <WorkflowContextCitations citations={analysis.data.contextCitations} />
          <RequirementFindingsReview
            key={findingsReviewVersion}
            findings={findings}
            summary={analysis.data.summary}
            selectedIds={selectedFindingIds}
            onChange={changeFindings}
            onSelectedIdsChange={changeSelectedFindingIds}
            footer={
              <div className="space-y-4">
                <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
                  <RequirementMentionPicker
                    users={projectUsers}
                    selectedUserIds={selectedMentionUserIds}
                    selectedUsers={selectedMentionUsers}
                    loading={projectUsersState.loading}
                    error={projectUsersState.error}
                    disabled={!scope}
                    onSelectionChange={changeMentionUsers}
                  />
                  <ConfirmationDialog
                    trigger={
                      <Button
                        disabled={
                          !scope ||
                          !targetWorkItemId ||
                          !selectedFindingList.length ||
                          invalidSelectedFindingCount > 0 ||
                          pushState.loading ||
                          Boolean(pushState.data?.success)
                        }
                        className="w-full xl:w-auto"
                      >
                        {pushState.loading ? <Loader2 className="animate-spin" /> : <Send />}
                        {pushState.data?.success ? "Comment Pushed" : pushState.loading ? "Pushing..." : "Push Comment"}
                      </Button>
                    }
                    title="Push requirements analysis comment?"
                    description={
                      <div className="space-y-1">
                        <p>Project: {scope?.azureProjectName ?? "Selected Azure DevOps project"}</p>
                        <p>Target work item: {targetWorkItemId}</p>
                        <p>Selected findings: {selectedFindingList.length}</p>
                        <p>Mentioned members: {selectedMentionUsers.length}</p>
                        <p className="pt-1">Only the current selected and valid findings will be included.</p>
                      </div>
                    }
                    confirmLabel="Push comment"
                    onConfirm={pushComment}
                  />
                </div>

                {invalidSelectedFindingCount > 0 ? (
                  <Callout tone="warning">
                    Resolve validation issues in the {invalidSelectedFindingCount} selected finding
                    {invalidSelectedFindingCount === 1 ? "" : "s"} before pushing the comment.
                  </Callout>
                ) : null}
                {pushState.error ? <ErrorBlock message={pushState.error} /> : null}
                {pushState.data?.success ? (
                  <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 p-4 text-sm text-success">
                    <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                    <div>
                      <div className="font-semibold text-foreground">Comment pushed to Azure DevOps</div>
                      <p className="mt-1 text-success">The selected requirements findings were added to the target work item.</p>
                    </div>
                  </div>
                ) : null}
              </div>
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function RequirementChecklistSelector({
  selectedIds,
  onToggle,
  onSelectAll,
  onClearAll,
}: {
  selectedIds: RequirementAnalysisChecklistItemId[];
  onToggle: (checklistItemId: RequirementAnalysisChecklistItemId, checked: boolean) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) {
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allSelected = selectedIds.length === allRequirementAnalysisChecklistItemIds.length;
  const noneSelected = selectedIds.length === 0;

  return (
    <div className="rounded-md border border-border bg-muted p-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Requirements Analysis Checklist</div>
          <div className="text-xs text-muted-foreground">
            {selectedIds.length} of {allRequirementAnalysisChecklistItemIds.length} selected
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={onSelectAll} disabled={allSelected} className="h-8 px-3 text-xs">
            Select all
          </Button>
          <Button variant="ghost" onClick={onClearAll} disabled={noneSelected} className="h-8 px-3 text-xs">
            Clear all
          </Button>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {requirementAnalysisChecklistOptions.map((checklistItem) => {
          const checked = selectedIdSet.has(checklistItem.id);
          return (
            <label
              key={checklistItem.id}
              className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground transition hover:border-primary/30 hover:bg-accent"
            >
              <Checkbox checked={checked} onCheckedChange={(value) => onToggle(checklistItem.id, value === true)} aria-label={checklistItem.title} />
              <span className="leading-5">{checklistItem.title}</span>
            </label>
          );
        })}
      </div>

      {noneSelected ? (
        <div className="mt-3 rounded-md border border-warning/40 bg-warning/15 px-3 py-2 text-sm text-foreground">
          Select at least one checklist item to run analysis or prepare the external LLM prompt.
        </div>
      ) : null}
    </div>
  );
}

function RequirementMentionPicker({
  users,
  selectedUserIds,
  selectedUsers,
  loading,
  error,
  disabled,
  onSelectionChange,
}: {
  users: ProjectUser[];
  selectedUserIds: string[];
  selectedUsers: ProjectUser[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onSelectionChange: (userIds: string[]) => void;
}) {
  function setUserSelected(userId: string, selected: boolean) {
    const nextIds = selected
      ? [...selectedUserIds, userId].filter((value, index, values) => values.indexOf(value) === index)
      : selectedUserIds.filter((value) => value !== userId);
    onSelectionChange(nextIds);
  }

  return (
    <div className="w-full rounded-md border border-border bg-card p-3 xl:max-w-3xl xl:flex-1">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-foreground">Mention members</div>
          <div className="mt-2 flex min-h-8 flex-wrap items-center gap-2">
            {selectedUsers.length ? selectedUsers.map((user) => (
              <UiBadge key={user.id} variant="secondary" className="h-7 max-w-full gap-1 rounded-md pl-2 pr-1">
                <span className="max-w-[220px] truncate">{projectUserLabel(user)}</span>
                <button
                  type="button"
                  className="rounded-[4px] p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  onClick={() => setUserSelected(user.id, false)}
                  aria-label={`Remove ${user.displayName}`}
                >
                  <X className="size-3" />
                </button>
              </UiBadge>
            )) : (
              <span className="text-sm text-muted-foreground">No members selected</span>
            )}
          </div>
          {error ? <div className="mt-2 text-xs text-destructive">{error}</div> : null}
        </div>

        <ProjectUserPicker
          mode="multiple"
          value={selectedUserIds}
          onValueChange={onSelectionChange}
          users={users}
          loading={loading}
          error={error}
          disabled={disabled}
          placeholder="Mention members"
          ariaLabel="Mention members"
          triggerVariant="secondary"
          triggerClassName="h-8 w-full lg:w-auto"
          contentClassName="w-[360px]"
          align="end"
        />
      </div>
    </div>
  );
}
