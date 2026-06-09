"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Copy, Play, Send, X } from "lucide-react";

import { Badge as UiBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProjectUserPicker, projectUserLabel } from "@/components/domain/project-user-picker";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { Callout } from "@/components/qa/callout";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { AiGenerationProgress } from "@/components/workflow/ai-generation-progress";
import { AiGenerationCompletedMetrics } from "@/components/workflow/ai-generation-metrics";
import { useAiGeneration } from "@/components/workflow/use-ai-generation";
import { ExtraInstructionsField } from "@/components/workflow/extra-instructions-field";
import { WorkItemPreview, WORK_ITEM_ID_PLACEHOLDER, WORK_ITEM_ID_TITLE } from "@/components/workflow/work-item-loader";
import {
  ErrorBlock,
  Metric,
  SectionCard,
  SummaryCard,
  SummaryTotalCard,
  ToneBadge,
  copyTextWithFeedback,
  formatEnumLabel,
  formatPercentage,
  postJson,
  projectWarning,
  scrollToNextStep,
  severityTone,
  type SummaryRow,
  useActiveProject,
} from "@/components/workflow/test-intelligence-shared";
import type {
  ApiState,
  ManualPromptDraft,
  RequirementAnalysisRunResult,
  RequirementFinding,
  RequirementSummary,
  WorkflowMode,
} from "@/components/workflow/test-intelligence-types";
import {
  allRequirementAnalysisChecklistItemIds,
  requirementAnalysisChecklistOptions,
  type RequirementAnalysisChecklistItemId,
} from "@/modules/requirement-analysis/checklist-options";
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

function severityMarker(value: RequirementFinding["severity"]) {
  return `[${formatEnumLabel(value)}]`;
}

function checklistItemTitle(checklistItemId: RequirementAnalysisChecklistItemId) {
  return requirementAnalysisChecklistOptions.find((checklistItem) => checklistItem.id === checklistItemId)?.title ?? formatEnumLabel(checklistItemId);
}

function buildCommentBodyWithMentions(commentBody: string, mentionedUsers: ProjectUser[]) {
  if (!mentionedUsers.length) return commentBody;
  const mentionLine = mentionedUsers.map((user) => `@<${user.id}>`).join(" ");
  return `${mentionLine}\n\n${commentBody.trim()}`;
}

function countFindingsBySeverity(findings: RequirementFinding[]) {
  return findings.reduce(
    (counts, finding) => {
      counts.total += 1;
      counts[finding.severity] += 1;
      return counts;
    },
    { total: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
}

function buildCommentSummary(summary: RequirementSummary, findings: RequirementFinding[]) {
  const counts = countFindingsBySeverity(findings);
  const severityLines = [
    counts.critical > 0 ? `- **Critical findings:** ${counts.critical}` : null,
    `- **High findings:** ${counts.high}`,
    `- **Medium findings:** ${counts.medium}`,
    `- **Low findings:** ${counts.low}`,
    counts.info > 0 ? `- **Info findings:** ${counts.info}` : null,
  ].filter(Boolean);

  return [
    "## Summary",
    `- **Quality:** ${formatEnumLabel(summary.overallQuality)}`,
    `- **Clarity:** ${formatPercentage(summary.clarityScore)}`,
    `- **Completeness:** ${formatPercentage(summary.completenessScore)}`,
    `- **Testability:** ${formatPercentage(summary.testabilityScore)}`,
    `- **Total findings:** ${counts.total}`,
    ...severityLines,
  ].join("\n");
}

export function RequirementAnalysisClient() {
  const scope = useActiveProject();
  const findingsCardRef = useRef<HTMLDivElement | null>(null);
  const finalReviewCardRef = useRef<HTMLDivElement | null>(null);
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
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
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [selectedFindings, setSelectedFindings] = useState<Record<string, boolean>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewButtonAnimating, setReviewButtonAnimating] = useState(false);
  const [finalComment, setFinalComment] = useState("");
  const [finalCommentCopied, setFinalCommentCopied] = useState(false);
  const [reviewApproved, setReviewApproved] = useState(false);
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
    setHasUnfinishedWork(false);
  }, [scope?.azureProjectId]);
  const sortedFindingList = useMemo(
    () => [...(analysis.data?.findings ?? [])].sort((left, right) => severityRank(left.severity) - severityRank(right.severity)),
    [analysis.data],
  );
  const findingStats = useMemo(() => {
    const findings = analysis.data?.findings ?? [];
    const severityCounts = countFindingsBySeverity(findings);
    const byType = findings.reduce<Record<string, number>>((counts, finding) => {
      counts[finding.issueType] = (counts[finding.issueType] ?? 0) + 1;
      return counts;
    }, {});

    return {
      total: severityCounts.total,
      bySeverity: severityCounts,
      byType: Object.entries(byType).sort(([firstType], [secondType]) => firstType.localeCompare(secondType)),
    };
  }, [analysis.data]);
  const severityBreakdown = useMemo<SummaryRow[]>(() => [
    { label: "Critical", value: findingStats.bySeverity.critical, tone: "red" },
    { label: "High", value: findingStats.bySeverity.high, tone: "red" },
    { label: "Medium", value: findingStats.bySeverity.medium, tone: "amber" },
    { label: "Low", value: findingStats.bySeverity.low, tone: "green" },
    { label: "Info", value: findingStats.bySeverity.info, tone: "slate" },
  ], [findingStats]);
  const typeBreakdown = useMemo<SummaryRow[]>(
    () => findingStats.byType.map(([type, count]) => ({ label: formatEnumLabel(type), value: count, tone: "cyan" as const })),
    [findingStats],
  );
  const selectedFindingList = useMemo(
    () => sortedFindingList.filter((finding) => selectedFindings[finding.id]),
    [selectedFindings, sortedFindingList],
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
    setHasUnfinishedWork(true);
    setTargetWorkItemId(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    setSelectedMentionUserIds([]);
  }

  function changeExtraInstructions(value: string) {
    setHasUnfinishedWork(true);
    setExtraInstructions(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function resetManualDraftForChecklistChange() {
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
    setHasUnfinishedWork(data.findings.length > 0);
    setAnalysis({ loading: false, error: null, data });
    setSelectedFindings(Object.fromEntries(data.findings.map((finding) => [finding.id, true])));
    setReviewOpen(false);
    setFinalComment("");
    setFinalCommentCopied(false);
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
    setSelectedMentionUserIds([]);
  }

  async function runAnalysis() {
    if (!scope || !targetWorkItemId || !checklistSelectionValid || !extraInstructionsValid) return;
    if (gen.isRunning) return;
    setAnalysis({ loading: true, error: null, data: null });
    const data = await gen.start((signal) =>
      postJson<RequirementAnalysisRunResult>(
        "/api/requirement-analysis/run",
        { scope, targetWorkItemId, enabledChecklistItemIds, extraInstructions: normalizeExtraInstructions(extraInstructions) },
        signal,
      ),
    );
    if (data) {
      applyAnalysisResult(data);
    } else {
      // cancelled or failed: the progress panel owns the message.
      setAnalysis({ loading: false, error: null, data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !checklistSelectionValid || !extraInstructionsValid) return;
    if (prep.isRunning) return;
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
    return [
      `# iTestFlow Requirement Analysis for ${targetWorkItemId}`,
      buildCommentSummary(analysis.data.summary, selectedFindingList),
      "---",
      analysis.data.summary.summaryText,
      "## Findings", "---",
      ...selectedFindingList.map((finding) => [
        `### ${severityMarker(finding.severity)} ${finding.title}`,
        finding.description,
        `**Checklist:** ${checklistItemTitle(finding.checklistItemId)}`,
        `**Issue Type:** ${formatEnumLabel(finding.issueType)}`,
        `**Risk:** ${formatEnumLabel(finding.riskLevel)} - ${finding.riskJustification}`,
        `**Suggested resolution:** ${finding.suggestion}`, "---",
      ].join("\n\n")),
    ].join("\n\n");
  }

  function openReview() {
    const commentBody = buildCommentBody();
    if (!commentBody) return;
    setReviewButtonAnimating(true);
    window.setTimeout(() => setReviewButtonAnimating(false), 220);
    setFinalComment(commentBody);
    setFinalCommentCopied(false);
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
    setReviewOpen(true);
    scrollToNextStep(finalReviewCardRef);
  }

  function changeFindingSelection(findingId: string, checked: boolean) {
    setHasUnfinishedWork(true);
    setSelectedFindings((current) => ({ ...current, [findingId]: checked }));
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
  }

  function changeFinalComment(value: string) {
    setHasUnfinishedWork(true);
    setFinalComment(value);
    setFinalCommentCopied(false);
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
  }

  function changeMentionUsers(userIds: string[]) {
    setHasUnfinishedWork(true);
    setSelectedMentionUserIds(userIds);
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
  }

  async function pushComment() {
    if (
      !scope ||
      !targetWorkItemId ||
      !analysis.data ||
      !selectedFindingList.length ||
      !reviewApproved ||
      !finalComment.trim() ||
      pushState.data?.success
    ) return;
    setPushState({ loading: true, error: null, data: null });
    try {
      await postJson("/api/requirement-analysis/comment", {
        scope,
        targetWorkItemId,
        selectedFindingIds: selectedFindingList.map((finding) => finding.id),
        commentBody: buildCommentBodyWithMentions(finalComment, selectedMentionUsers),
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
      <SectionCard
        title="Target Requirement"
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
          <WorkItemPreview scope={scope} workItemId={targetWorkItemId} />
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

      {pushState.error ? <ErrorBlock message={pushState.error} /> : null}
      {gen.status !== "idle" && gen.status !== "completed" ? (
        <div ref={findingsCardRef}>
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
        </div>
      ) : null}
      {analysis.data ? (
        <div ref={findingsCardRef} className="space-y-2">
          {mode === "auto" && gen.status === "completed" ? (
            <AiGenerationCompletedMetrics elapsedSeconds={gen.elapsedSeconds} tokenUsage={gen.tokenUsage} />
          ) : null}
          <SectionCard title="Requirement Analysis Findings">
            <div className="grid gap-3 border-b border-border bg-muted p-4 lg:grid-cols-[180px_minmax(260px,1fr)_minmax(260px,1fr)]">
              <SummaryTotalCard label="Total Findings" total={findingStats.total} />
              <SummaryCard title="Severity Breakdown" rows={severityBreakdown} />
              <SummaryCard title="Type" rows={typeBreakdown} emptyLabel="No finding types yet" />
            </div>
            <div className="grid gap-3 border-b p-4 md:grid-cols-4">
              <Metric label="Quality" value={analysis.data.summary.overallQuality} />
              <Metric label="Clarity" value={analysis.data.summary.clarityScore} />
              <Metric label="Completeness" value={analysis.data.summary.completenessScore} />
              <Metric label="Testability" value={analysis.data.summary.testabilityScore} />
            </div>
            <div className="divide-y">
              {sortedFindingList.map((finding) => (
                <div key={finding.id} className="grid gap-4 p-4 xl:grid-cols-[32px_240px_minmax(0,1fr)_minmax(260px,0.85fr)]">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedFindings[finding.id])}
                    onChange={(event) => changeFindingSelection(finding.id, event.target.checked)}
                    className="mt-2 h-4 w-4"
                    aria-label={`Select ${finding.id}`}
                  />
                  <div>
                    <ToneBadge tone={severityTone(finding.severity)}>{formatEnumLabel(finding.severity)}</ToneBadge>
                    <div className="mt-2 text-xs font-medium text-muted-foreground">{checklistItemTitle(finding.checklistItemId)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Issue Type: {formatEnumLabel(finding.issueType)}</div>
                  </div>
                  <div>
                    <div className="font-medium">{finding.title}</div>
                    <p className="mt-2 text-sm text-muted-foreground">{finding.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">Risk: {formatEnumLabel(finding.riskLevel)} - {finding.riskJustification}</p>
                  </div>
                  <div className="rounded-md border border-border bg-accent p-3">
                    <div className="text-xs font-semibold text-primary">Suggested resolution</div>
                    <p className="mt-2 text-sm leading-6 text-foreground">{finding.suggestion}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t border-border p-4">
              <Button
                onClick={openReview}
                disabled={!selectedFindingList.length}
                className={`active:translate-y-px active:scale-[0.98] ${reviewButtonAnimating ? "scale-[0.98] ring-2 ring-primary/30" : ""}`}
              >
                <Send className="h-4 w-4" />
                Review Comment
              </Button>
            </div>
          </SectionCard>
        </div>
      ) : null}

      {reviewOpen ? (
        <div ref={finalReviewCardRef}>
        <SectionCard
          title="Final Comment Review"
          description="Edit and approve the exact comment before it is pushed to Azure DevOps."
          action={
            <Button
              variant="secondary"
              disabled={finalCommentCopied || !finalComment.trim()}
              onClick={() => {
                void copyTextWithFeedback(finalComment, setFinalCommentCopied);
              }}
              className="active:translate-y-px active:scale-[0.98]"
            >
              <Copy className="h-4 w-4" />
              {finalCommentCopied ? "Copied" : "Copy"}
            </Button>
          }
        >
          <div className="space-y-4 p-4">
            <RequirementMentionPicker
              users={projectUsers}
              selectedUserIds={selectedMentionUserIds}
              selectedUsers={selectedMentionUsers}
              loading={projectUsersState.loading}
              error={projectUsersState.error}
              disabled={!scope}
              onSelectionChange={changeMentionUsers}
            />
            <Textarea
              value={finalComment}
              onChange={(event) => changeFinalComment(event.target.value)}
              className="min-h-[320px] font-mono"
              aria-label="Final Azure DevOps comment"
            />
            <label className="flex items-start gap-3 rounded-md border border-border bg-card p-3 text-sm text-foreground">
              <input
                type="checkbox"
                checked={reviewApproved}
                onChange={(event) => {
                  setHasUnfinishedWork(true);
                  setReviewApproved(event.target.checked);
                }}
                className="mt-1 h-4 w-4"
              />
              <span>I reviewed the final comment text and selected findings. Push this comment to the Azure DevOps user story.</span>
            </label>
            {pushState.data?.success ? (
              <div className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 p-4 text-sm text-success">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                <div>
                  <div className="font-semibold text-foreground">Comment pushed to Azure DevOps</div>
                  <p className="mt-1 text-success">The approved review comment was added to the selected user story.</p>
                </div>
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button
                onClick={pushComment}
                disabled={!selectedFindingList.length || !reviewApproved || !finalComment.trim() || pushState.loading || Boolean(pushState.data?.success)}
              >
                <Send className="h-4 w-4" />
                {pushState.data?.success ? "Comment Pushed" : pushState.loading ? "Pushing..." : "Push Approved Comment"}
              </Button>
            </div>
          </div>
        </SectionCard>
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
          <div className="text-sm font-semibold text-foreground">Requirement Analysis Checklist</div>
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
    <div className="rounded-md border border-border bg-card p-3">
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
