"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Loader2, Play, Send, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, SelectInput, TextArea, TextInput } from "@/shared/components/ui";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type RequirementFinding = {
  id: string;
  type: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  suggestion: string;
  riskLevel: "high" | "medium" | "low";
  riskJustification: string;
  affectedAreas: string[];
  references: Array<{ module?: string; section?: string; sourceId?: string; description?: string }>;
  contradiction: boolean;
};

type RequirementSummary = {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  overallQuality: "poor" | "fair" | "good" | "excellent";
  completenessScore: number;
  clarityScore: number;
  testabilityScore: number;
  summaryText: string;
};

type RequirementAnalysisRunResult = {
  findings: RequirementFinding[];
  summary: RequirementSummary;
  recommendations: string[];
  contextUsed: string[];
  resolvedContextUsed?: unknown[];
};

type GeneratedTestCase = {
  id: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  type: string;
  category: string;
  tags?: string[];
  relatedAcceptanceCriteria?: string[];
  relatedBusinessRules?: string[];
  relatedModules?: string[];
  preconditions: string;
  testData?: string;
  steps: Array<{ stepNumber: number; action: string; expectedResult: string }>;
};

type TestCaseSummary = {
  totalCases: number;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  coverageEstimate: number;
};

type TestCaseGenerationRunResult = {
  testCases: GeneratedTestCase[];
  summary: TestCaseSummary;
  contextUsed: string[];
  resolvedContextUsed?: unknown[];
};

type WorkflowMode = "auto" | "manual";

type ManualPromptDraft = {
  prompt: string;
  promptVersion: string;
  selectedContextIds?: string[];
  resolvedContextUsed?: unknown[];
  retrievalTopK?: number;
};

type TestPlan = {
  id: string;
  name: string;
};

type TestSuite = {
  id: string;
  name: string;
  planId: string;
};

type ExistingReviewResult = {
  linkedTestCases: Array<{ id: string; title: string; testType?: string; automationSuitability?: string; steps?: unknown[] }>;
  findings: Array<{ id: string; severity: string; category: string; title: string; explanation: string; suggestedAction: string }>;
  suggestedAdditions: GeneratedTestCase[];
};

function useActiveProject() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  return scope;
}

function projectWarning(scope: ActiveProjectScope | null) {
  if (scope) return null;
  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
      <AlertTriangle className="h-4 w-4" />
      Please select an Azure DevOps project before running this action.
    </div>
  );
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = parseJsonResponse(text, response.ok);
  if (!response.ok) throw new Error(json.error ?? `Request failed: ${response.status}`);
  return json as T;
}

function parseJsonResponse(text: string, ok: boolean) {
  try {
    return JSON.parse(text);
  } catch {
    if (ok) throw new Error("The server returned an invalid JSON response.");
    return { error: "The server returned a non-JSON response. Check the server logs or runtime configuration." };
  }
}

function severityTone(value: string) {
  if (value === "critical" || value === "high" || value === "High") return "red" as const;
  if (value === "medium" || value === "Medium") return "amber" as const;
  return "emerald" as const;
}

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

function scrollToNextStep(ref: React.RefObject<HTMLElement | null>) {
  window.setTimeout(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);
}

const COPY_FEEDBACK_MS = 3000;

async function copyTextWithFeedback(text: string, setCopied: (copied: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  } catch (error) {
    console.error("Clipboard copy failed", error);
  }
}

function formatEnumLabel(value: string) {
  const acronyms = new Set(["api", "llm", "ui", "ux"]);
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      const normalized = part.toLowerCase();
      if (acronyms.has(normalized)) return normalized.toUpperCase();
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(" ");
}

function formatPercentage(value: number) {
  return `${Math.round(value)}%`;
}

function severityMarker(value: RequirementFinding["severity"]) {
  return `[${formatEnumLabel(value)}]`;
}

function qualityTone(value: string) {
  if (value === "excellent" || value === "good") return "emerald" as const;
  if (value === "fair") return "amber" as const;
  return "red" as const;
}

function scoreTone(value: number) {
  if (value >= 80) return "emerald" as const;
  if (value >= 60) return "amber" as const;
  return "red" as const;
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

export function LiveDashboard() {
  const scope = useActiveProject();
  const [health, setHealth] = useState<string>("Checking");
  const [projectsStatus, setProjectsStatus] = useState<string>("Checking");

  useEffect(() => {
    fetch("/api/health").then((response) => setHealth(response.ok ? "Ready" : "Unavailable"));
    fetch("/api/azure-devops/projects")
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error);
        setProjectsStatus("Connected");
      })
      .catch(() => setProjectsStatus("Not configured"));
  }, []);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card className="p-4">
        <div className="text-sm font-medium text-slate-500">Local Runtime</div>
        <div className="mt-2 text-[22px] font-bold text-slate-950">{health}</div>
        <p className="mt-1 text-xs text-slate-500">Next.js + local SQLite</p>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-medium text-slate-500">Azure DevOps</div>
        <div className="mt-2 text-[22px] font-bold text-slate-950">{projectsStatus}</div>
        <p className="mt-1 text-xs text-slate-500">Live REST API integration</p>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-medium text-slate-500">Active Project</div>
        <div className="mt-2 truncate text-[22px] font-bold text-slate-950">{scope?.azureProjectName ?? "Not selected"}</div>
        <p className="mt-1 text-xs text-slate-500">Controls every workflow scope</p>
      </Card>
      <Card className="p-4">
        <div className="text-sm font-medium text-slate-500">LLM Provider</div>
        <div className="mt-2 truncate text-[22px] font-bold text-slate-950">{process.env.NEXT_PUBLIC_LLM_PROVIDER_LABEL ?? "Server configured"}</div>
        <p className="mt-1 text-xs text-slate-500">AI calls run server-side only</p>
      </Card>
    </div>
  );
}

export function RequirementAnalysisClient() {
  const scope = useActiveProject();
  const findingsCardRef = useRef<HTMLDivElement | null>(null);
  const finalReviewCardRef = useRef<HTMLDivElement | null>(null);
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [analysis, setAnalysis] = useState<ApiState<RequirementAnalysisRunResult>>({
    loading: false,
    error: null,
    data: null,
  });
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
  const sortedFindingList = useMemo(
    () => [...(analysis.data?.findings ?? [])].sort((left, right) => severityRank(left.severity) - severityRank(right.severity)),
    [analysis.data],
  );
  const selectedFindingList = useMemo(
    () => sortedFindingList.filter((finding) => selectedFindings[finding.id]),
    [selectedFindings, sortedFindingList],
  );

  function changeTargetWorkItemId(value: string) {
    setTargetWorkItemId(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function applyAnalysisResult(data: RequirementAnalysisRunResult) {
    setAnalysis({ loading: false, error: null, data });
    setSelectedFindings(Object.fromEntries(data.findings.map((finding) => [finding.id, true])));
    setReviewOpen(false);
    setFinalComment("");
    setFinalCommentCopied(false);
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
  }

  async function runAnalysis() {
    if (!scope || !targetWorkItemId) return;
    setAnalysis({ loading: true, error: null, data: null });
    try {
      const data = await postJson<RequirementAnalysisRunResult>(
        "/api/requirement-analysis/run",
        { scope, targetWorkItemId },
      );
      applyAnalysisResult(data);
    } catch (error) {
      setAnalysis({ loading: false, error: error instanceof Error ? error.message : "Requirement analysis failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/requirement-analysis/manual/draft", {
        scope,
        targetWorkItemId,
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
      const data = await postJson<RequirementAnalysisRunResult>("/api/requirement-analysis/manual/submit", {
        scope,
        targetWorkItemId,
        rawOutput: manualResponse,
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
        `**Type:** ${formatEnumLabel(finding.type)}`,
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
    setSelectedFindings((current) => ({ ...current, [findingId]: checked }));
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
  }

  function changeFinalComment(value: string) {
    setFinalComment(value);
    setFinalCommentCopied(false);
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
        commentBody: finalComment,
      });
      setPushState({ loading: false, error: null, data: { success: true } });
    } catch (error) {
      setPushState({ loading: false, error: error instanceof Error ? error.message : "Azure DevOps comment push failed.", data: null });
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader
          title="Target Requirement"
          description="Enter a real Azure DevOps work item ID. Project context is selected automatically for this run."
          action={<WorkflowModeTabs mode={mode} onChange={setMode} />}
        />
        <div className="space-y-4 p-4">
          <div className="grid gap-4 lg:grid-cols-[240px_auto]">
            <TextInput value={targetWorkItemId} onChange={(event) => changeTargetWorkItemId(event.target.value)} placeholder="Work item ID, e.g. 1234" />
            {mode === "auto" ? (
              <Button onClick={runAnalysis} disabled={!scope || !targetWorkItemId || analysis.loading}>
                <Play className="h-4 w-4" />
                {analysis.loading ? "Analyzing..." : "Analyze"}
              </Button>
            ) : (
              <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || manualDraft.loading}>
                <Play className="h-4 w-4" />
                {manualDraft.loading ? "Preparing..." : "Prepare Prompt"}
              </Button>
            )}
          </div>
          {mode === "manual" ? (
            <ManualLLMPanel
              draft={manualDraft.data}
              response={manualResponse}
              onResponseChange={setManualResponse}
              onSubmit={submitManualResponse}
              submitLabel={manualSubmitLoading ? "Validating..." : "Validate and Continue"}
              submitting={manualSubmitLoading}
              error={manualDraft.error ?? manualSubmitError}
            />
          ) : null}
        </div>
      </Card>

      {analysis.error ? <ErrorBlock message={analysis.error} /> : null}
      {pushState.error ? <ErrorBlock message={pushState.error} /> : null}
      {analysis.data ? (
        <div ref={findingsCardRef}>
          <Card>
            <CardHeader title="Requirement Analysis Findings" />
            <div className="grid gap-3 border-b p-4 md:grid-cols-4">
              <Metric label="Quality" value={analysis.data.summary.overallQuality} />
              <Metric label="Clarity" value={analysis.data.summary.clarityScore} />
              <Metric label="Completeness" value={analysis.data.summary.completenessScore} />
              <Metric label="Testability" value={analysis.data.summary.testabilityScore} />
            </div>
            <div className="divide-y">
              {sortedFindingList.map((finding) => (
                <div key={finding.id} className="grid gap-4 p-4 xl:grid-cols-[32px_150px_minmax(0,1fr)_minmax(260px,0.85fr)]">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedFindings[finding.id])}
                    onChange={(event) => changeFindingSelection(finding.id, event.target.checked)}
                    className="mt-2 h-4 w-4"
                    aria-label={`Select ${finding.id}`}
                  />
                  <div>
                    <Badge tone={severityTone(finding.severity)}>{formatEnumLabel(finding.severity)}</Badge>
                    <div className="mt-2 text-xs font-medium text-slate-500">{formatEnumLabel(finding.type)}</div>
                  </div>
                  <div>
                    <div className="font-medium">{finding.title}</div>
                    <p className="mt-2 text-sm text-muted-foreground">{finding.description}</p>
                    <p className="mt-2 text-xs text-muted-foreground">Risk: {formatEnumLabel(finding.riskLevel)} - {finding.riskJustification}</p>
                  </div>
                  <div className="rounded-md border border-blue-100 bg-blue-50 p-3">
                    <div className="text-xs font-semibold text-blue-900">Suggested resolution</div>
                    <p className="mt-2 text-sm leading-6 text-slate-700">{finding.suggestion}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-end border-t border-[#d8e2ef] p-4">
              <Button
                onClick={openReview}
                disabled={!selectedFindingList.length}
                className={`active:translate-y-px active:scale-[0.98] ${reviewButtonAnimating ? "scale-[0.98] ring-2 ring-blue-200" : ""}`}
              >
                <Send className="h-4 w-4" />
                Review Comment
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {reviewOpen ? (
        <div ref={finalReviewCardRef}>
        <Card>
          <CardHeader
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
          />
          <div className="space-y-4 p-4">
            <TextArea
              value={finalComment}
              onChange={(event) => changeFinalComment(event.target.value)}
              className="min-h-[320px] font-mono"
              aria-label="Final Azure DevOps comment"
            />
            <label className="flex items-start gap-3 rounded-md border border-[#c8d4e4] bg-white p-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={reviewApproved}
                onChange={(event) => setReviewApproved(event.target.checked)}
                className="mt-1 h-4 w-4"
              />
              <span>I reviewed the final comment text and selected findings. Push this comment to the Azure DevOps user story.</span>
            </label>
            {pushState.data?.success ? (
              <div className="flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
                <div>
                  <div className="font-semibold text-emerald-900">Comment pushed to Azure DevOps</div>
                  <p className="mt-1 text-emerald-700">The approved review comment was added to the selected user story.</p>
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
        </Card>
        </div>
      ) : null}
    </div>
  );
}

export function TestCaseGenerationClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [state, setState] = useState<ApiState<TestCaseGenerationRunResult>>({ loading: false, error: null, data: null });
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);

  function changeTargetWorkItemId(value: string) {
    setTargetWorkItemId(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function applyGeneratedCases(data: TestCaseGenerationRunResult) {
    setState({ loading: false, error: null, data });
    setTestCases(data.testCases);
    window.localStorage.setItem("itestflow.generatedTestCases", JSON.stringify({ targetWorkItemId, testCases: data.testCases }));
  }

  async function generate() {
    if (!scope || !targetWorkItemId) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<TestCaseGenerationRunResult>("/api/test-cases/generate", {
        scope,
        targetWorkItemId,
        options: { depth: "balanced" },
      });
      applyGeneratedCases(data);
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Test case generation failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/test-cases/manual/draft", {
        scope,
        targetWorkItemId,
        options: { depth: "balanced" },
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
    } catch (error) {
      setManualSubmitError(error instanceof Error ? error.message : "External LLM response validation failed.");
    } finally {
      setManualSubmitLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader
          title="Generate Test Cases from Azure DevOps Requirement"
          description="Project context is selected automatically for this run."
          action={<WorkflowModeTabs mode={mode} onChange={setMode} />}
        />
        <div className="space-y-4 p-4">
          <div className="grid gap-4 lg:grid-cols-[240px_auto]">
            <TextInput value={targetWorkItemId} onChange={(event) => changeTargetWorkItemId(event.target.value)} placeholder="Work item ID" />
            {mode === "auto" ? (
              <Button onClick={generate} disabled={!scope || !targetWorkItemId || state.loading}>
                <Play className="h-4 w-4" />
                {state.loading ? "Generating..." : "Generate"}
              </Button>
            ) : (
              <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || manualDraft.loading}>
                <Play className="h-4 w-4" />
                {manualDraft.loading ? "Preparing..." : "Prepare Prompt"}
              </Button>
            )}
          </div>
          {mode === "manual" ? (
            <ManualLLMPanel
              draft={manualDraft.data}
              response={manualResponse}
              onResponseChange={setManualResponse}
              onSubmit={submitManualResponse}
              submitLabel={manualSubmitLoading ? "Validating..." : "Validate and Continue"}
              submitting={manualSubmitLoading}
              error={manualDraft.error ?? manualSubmitError}
            />
          ) : null}
        </div>
      </Card>
      {state.error ? <ErrorBlock message={state.error} /> : null}
      {testCases.length ? (
        <EditableGeneratedCases testCases={testCases} setTestCases={setTestCases} />
      ) : (
        <EmptyBlock message="No generated test cases yet. Run generation against a real Azure DevOps work item." />
      )}
    </div>
  );
}

export function ExistingTestCaseReviewClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [contextIds, setContextIds] = useState("");
  const [state, setState] = useState<ApiState<ExistingReviewResult>>({ loading: false, error: null, data: null });
  const selectedContextIds = useMemo(() => contextIds.split(",").map((item) => item.trim()).filter(Boolean), [contextIds]);

  async function review() {
    if (!scope || !targetWorkItemId) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<ExistingReviewResult>("/api/existing-test-case-review/run", {
        scope,
        targetWorkItemId,
        selectedContextIds,
      });
      setState({ loading: false, error: null, data });
      window.localStorage.setItem("itestflow.generatedTestCases", JSON.stringify({ targetWorkItemId, testCases: data.suggestedAdditions }));
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Existing linked test case review failed.", data: null });
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader title="Review Existing Azure DevOps Linked Test Cases" description="Fetches TestedBy / Tests relationships from the selected story." />
        <div className="grid gap-4 p-4 lg:grid-cols-[240px_1fr_auto]">
          <TextInput value={targetWorkItemId} onChange={(event) => setTargetWorkItemId(event.target.value)} placeholder="User story ID" />
          <TextInput value={contextIds} onChange={(event) => setContextIds(event.target.value)} placeholder="Selected context IDs, comma separated" />
          <Button onClick={review} disabled={!scope || !targetWorkItemId || state.loading}>
            <Play className="h-4 w-4" />
            {state.loading ? "Reviewing..." : "Run Review"}
          </Button>
        </div>
      </Card>
      {state.error ? <ErrorBlock message={state.error} /> : null}
      {state.data ? (
        <>
          <Card>
            <CardHeader title="Linked Test Cases from Azure DevOps" />
            <div className="divide-y">
              {state.data.linkedTestCases.map((testCase) => (
                <div key={testCase.id} className="grid gap-3 p-4 md:grid-cols-[140px_1fr_120px]">
                  <span className="font-mono text-xs text-blue-600">{testCase.id}</span>
                  <span className="font-medium">{testCase.title}</span>
                  <span>{testCase.steps?.length ?? 0} steps</span>
                </div>
              ))}
            </div>
          </Card>
          <Card>
            <CardHeader title="Review Findings" />
            <div className="divide-y">
              {state.data.findings.map((finding) => (
                <div key={finding.id} className="grid gap-3 p-4 md:grid-cols-[120px_160px_1fr]">
                  <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                  <span>{finding.category}</span>
                  <div>
                    <div className="font-medium">{finding.title}</div>
                    <p className="mt-1 text-sm text-muted-foreground">{finding.explanation}</p>
                    <p className="mt-1 text-sm text-blue-600">{finding.suggestedAction}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <EditableGeneratedCases testCases={state.data.suggestedAdditions} setTestCases={() => undefined} title="Suggested Additions" />
        </>
      ) : null}
    </div>
  );
}

export function PublishTestCasesClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [testPlanId, setTestPlanId] = useState("");
  const [testSuiteId, setTestSuiteId] = useState("");
  const [testPlans, setTestPlans] = useState<TestPlan[]>([]);
  const [testSuites, setTestSuites] = useState<TestSuite[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);
  const [state, setState] = useState<ApiState<{ results: unknown[] }>>({ loading: false, error: null, data: null });

  useEffect(() => {
    const raw = window.localStorage.getItem("itestflow.generatedTestCases");
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { targetWorkItemId?: string; testCases?: GeneratedTestCase[] };
      setTargetWorkItemId(parsed.targetWorkItemId ?? "");
      setTestCases(parsed.testCases ?? []);
    } catch {
      setTestCases([]);
    }
  }, []);

  useEffect(() => {
    if (!scope) return;
    setPlanError(null);
    postJson<{ testPlans: TestPlan[] }>("/api/azure-devops/test-plans", { scope })
      .then((data) => setTestPlans(data.testPlans))
      .catch((error: unknown) => setPlanError(error instanceof Error ? error.message : "Azure Test Plan fetch failed."));
  }, [scope]);

  useEffect(() => {
    if (!scope || !testPlanId) return;
    setPlanError(null);
    postJson<{ testSuites: TestSuite[] }>("/api/azure-devops/test-suites", { scope, testPlanId })
      .then((data) => setTestSuites(data.testSuites))
      .catch((error: unknown) => setPlanError(error instanceof Error ? error.message : "Azure Test Suite fetch failed."));
  }, [scope, testPlanId]);

  async function publish() {
    if (!scope || !targetWorkItemId || !testPlanId || !testSuiteId || !testCases.length) return;
    const confirmed = window.confirm(
      `You are about to add ${testCases.length} selected test cases to:\nProject: ${scope.azureProjectName}\nTest Plan: ${testPlanId}\nTest Suite: ${testSuiteId}\nLinked User Story: ${targetWorkItemId}\nDo you want to continue?`,
    );
    if (!confirmed) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ results: unknown[] }>("/api/publish/test-cases", {
        scope,
        targetWorkItemId,
        testPlanId,
        testSuiteId,
        testCases: testCases.map((testCase) => ({
          ...testCase,
          localId: testCase.id,
          targetUserStoryId: targetWorkItemId,
          steps: testCase.steps.map((step) => ({ action: step.action, expectedResult: step.expectedResult })),
          testType: testCase.type,
        })),
      });
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Publish failed.", data: null });
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader title="Publish Selected Test Cases to Azure Test Plans" />
        <div className="grid gap-4 p-4 lg:grid-cols-4">
          <TextInput value={targetWorkItemId} onChange={(event) => setTargetWorkItemId(event.target.value)} placeholder="Target user story ID" />
          <SelectInput value={testPlanId} onChange={(event) => setTestPlanId(event.target.value)}>
            <option value="">Select Azure Test Plan</option>
            {testPlans.map((plan) => (
              <option key={plan.id} value={plan.id}>
                {plan.id} - {plan.name}
              </option>
            ))}
          </SelectInput>
          <SelectInput value={testSuiteId} onChange={(event) => setTestSuiteId(event.target.value)}>
            <option value="">Select Azure Test Suite</option>
            {testSuites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.id} - {suite.name}
              </option>
            ))}
          </SelectInput>
          <Button onClick={publish} disabled={!scope || !targetWorkItemId || !testPlanId || !testSuiteId || !testCases.length || state.loading}>
            <Send className="h-4 w-4" />
            {state.loading ? "Publishing..." : `Publish ${testCases.length || ""}`}
          </Button>
        </div>
      </Card>
      {planError ? <ErrorBlock message={planError} /> : null}
      {state.error ? <ErrorBlock message={state.error} /> : null}
      {testCases.length ? <EditableGeneratedCases testCases={testCases} setTestCases={setTestCases} title="Cases Ready to Publish" /> : <EmptyBlock message="No approved generated cases found in this browser session. Generate or review additions first." />}
      {state.data ? (
        <Card>
          <CardHeader title="Publish Results" />
          <pre className="overflow-auto p-4 text-xs text-muted-foreground">{JSON.stringify(state.data.results, null, 2)}</pre>
        </Card>
      ) : null}
    </div>
  );
}

export function AuditLogsClient() {
  const [state, setState] = useState<ApiState<{ logs: unknown[] }>>({ loading: true, error: null, data: null });
  const [llmState, setLlmState] = useState<ApiState<{ logs: unknown[] }>>({ loading: true, error: null, data: null });

  useEffect(() => {
    fetch("/api/audit-logs", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Audit log fetch failed.");
        setState({ loading: false, error: null, data: json });
      })
      .catch((error: unknown) => setState({ loading: false, error: error instanceof Error ? error.message : "Audit log fetch failed.", data: null }));
    fetch("/api/llm-request-logs", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "LLM request log fetch failed.");
        setLlmState({ loading: false, error: null, data: json });
      })
      .catch((error: unknown) => setLlmState({ loading: false, error: error instanceof Error ? error.message : "LLM request log fetch failed.", data: null }));
  }, []);

  if (state.error) return <ErrorBlock message={state.error} />;
  if (llmState.error) return <ErrorBlock message={llmState.error} />;
  if (state.loading || llmState.loading) return <EmptyBlock message="Loading live audit and LLM request logs..." />;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="LLM Request Logs" description="Recent prompts, provider payloads, raw responses, and validation status stored locally." />
        <pre className="max-h-[620px] overflow-auto p-4 text-xs text-muted-foreground">{JSON.stringify(llmState.data?.logs ?? [], null, 2)}</pre>
      </Card>
      <Card>
        <CardHeader title="Live Audit Log Entries" />
        <pre className="max-h-[620px] overflow-auto p-4 text-xs text-muted-foreground">{JSON.stringify(state.data?.logs ?? [], null, 2)}</pre>
      </Card>
    </div>
  );
}

function WorkflowModeTabs({ mode, onChange }: { mode: WorkflowMode; onChange: (mode: WorkflowMode) => void }) {
  const itemClass = (value: WorkflowMode) =>
    `h-8 rounded-[6px] px-3 text-sm font-medium transition ${
      mode === value ? "bg-[#2f62e6] text-white" : "text-slate-600 hover:bg-blue-50 hover:text-blue-700"
    }`;

  return (
    <div role="tablist" aria-label="LLM execution mode" className="inline-flex rounded-[8px] border border-[#c8d4e4] bg-white p-1">
      <button type="button" role="tab" aria-selected={mode === "auto"} className={itemClass("auto")} onClick={() => onChange("auto")}>
        Auto Generate
      </button>
      <button type="button" role="tab" aria-selected={mode === "manual"} className={itemClass("manual")} onClick={() => onChange("manual")}>
        External LLM
      </button>
    </div>
  );
}

function ManualLLMPanel({
  draft,
  response,
  onResponseChange,
  onSubmit,
  submitLabel,
  submitting,
  error,
}: {
  draft: ManualPromptDraft | null;
  response: string;
  onResponseChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  submitting: boolean;
  error?: string | null;
}) {
  const [promptCopied, setPromptCopied] = useState(false);

  if (!draft && !error) return null;

  return (
    <div className="space-y-4 rounded-md border border-[#c8d4e4] bg-[#f8fafc] p-4">
      {error ? <ErrorBlock message={error} /> : null}
      {draft ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-950">External LLM Prompt</div>
              <div className="text-xs text-slate-500">Prompt {draft.promptVersion}</div>
            </div>
            <Button
              variant="secondary"
              disabled={promptCopied}
              onClick={() => void copyTextWithFeedback(draft.prompt, setPromptCopied)}
              className="active:translate-y-px active:scale-[0.98]"
            >
              <Copy className="h-4 w-4" />
              {promptCopied ? "Copied" : "Copy Prompt"}
            </Button>
          </div>
          <TextArea value={draft.prompt} readOnly className="min-h-[360px] font-mono text-xs" aria-label="External LLM prompt" />
          <div>
            <div className="mb-2 text-sm font-semibold text-slate-950">External LLM Response</div>
            <TextArea
              value={response}
              onChange={(event) => onResponseChange(event.target.value)}
              className="min-h-[260px] font-mono text-xs"
              placeholder="Paste the external LLM JSON response here."
              aria-label="External LLM response"
            />
          </div>
          <div className="flex justify-end">
            <Button onClick={onSubmit} disabled={!response.trim() || submitting} className="active:translate-y-px active:scale-[0.98]">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {submitLabel}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function EditableGeneratedCases({
  testCases,
  setTestCases,
  title = "Generated Test Cases",
}: {
  testCases: GeneratedTestCase[];
  setTestCases: (testCases: GeneratedTestCase[]) => void;
  title?: string;
}) {
  function updateCase(index: number, next: GeneratedTestCase) {
    const updated = [...testCases];
    updated[index] = next;
    setTestCases(updated);
    const previous = window.localStorage.getItem("itestflow.generatedTestCases");
    let previousPayload: { targetWorkItemId?: string } = {};
    try {
      previousPayload = previous ? (JSON.parse(previous) as { targetWorkItemId?: string }) : {};
    } catch {
      previousPayload = {};
    }
    window.localStorage.setItem("itestflow.generatedTestCases", JSON.stringify({ ...previousPayload, testCases: updated }));
  }

  return (
    <Card>
      <CardHeader title={title} description="Edit titles and steps inline before publishing." />
      <div className="divide-y">
        {testCases.map((testCase, index) => (
          <div key={testCase.id} className="space-y-3 p-4">
            <div className="grid gap-3 lg:grid-cols-[120px_1fr_160px_160px]">
              <span className="font-mono text-xs text-blue-600">{testCase.id}</span>
              <TextInput value={testCase.title} onChange={(event) => updateCase(index, { ...testCase, title: event.target.value })} />
              <SelectInput value={testCase.priority} onChange={(event) => updateCase(index, { ...testCase, priority: event.target.value as GeneratedTestCase["priority"] })}>
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </SelectInput>
              <Badge tone="cyan">{testCase.type}</Badge>
            </div>
            <div className="rounded-md border">
              {testCase.steps.map((step, stepIndex) => (
                <div key={`${testCase.id}-${stepIndex}`} className="grid gap-2 border-b p-3 last:border-b-0 lg:grid-cols-[40px_1fr_1fr_42px]">
                  <span className="pt-2 font-mono text-xs text-muted-foreground">{stepIndex + 1}</span>
                  <TextInput
                    value={step.action}
                    onChange={(event) => {
                      const steps = [...testCase.steps];
                      steps[stepIndex] = { ...step, action: event.target.value };
                      updateCase(index, { ...testCase, steps });
                    }}
                  />
                  <TextInput
                    value={step.expectedResult}
                    onChange={(event) => {
                      const steps = [...testCase.steps];
                      steps[stepIndex] = { ...step, expectedResult: event.target.value };
                      updateCase(index, { ...testCase, steps });
                    }}
                  />
                  <Button
                    variant="ghost"
                    onClick={() => updateCase(index, { ...testCase, steps: testCase.steps.filter((_, current) => current !== stepIndex) })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  updateCase(index, {
                    ...testCase,
                    steps: [...testCase.steps, { stepNumber: testCase.steps.length + 1, action: "", expectedResult: "" }],
                  })
                }
              >
                Add Step
              </Button>
              <Button
                variant="secondary"
                onClick={() => navigator.clipboard.writeText(JSON.stringify(testCase, null, 2))}
              >
                <Copy className="h-4 w-4" />
                Copy JSON
              </Button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  const isNumeric = typeof value === "number";
  const displayValue = isNumeric ? formatPercentage(value) : formatEnumLabel(value);
  const tone = isNumeric ? scoreTone(value) : qualityTone(value);
  const toneStyles = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    red: "border-red-200 bg-red-50 text-red-700",
  }[tone];

  return (
    <div className={`rounded-md border p-4 ${toneStyles}`}>
      <div className="text-base font-semibold text-slate-600">{label}</div>
      <div className="mt-1 text-2xl font-bold">{displayValue}</div>
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <div className="flex items-center gap-2 font-semibold text-red-800">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        Action failed
      </div>
      <p className="mt-2 break-words text-red-800">{message}</p>
    </div>
  );
}

function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="rounded-[10px] border border-[#c8d4e4] bg-white p-6 text-sm text-slate-500">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-blue-600" />
        {message}
      </div>
    </div>
  );
}
