"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Loader2, Play, Plus, Send, Trash2, Users, X } from "lucide-react";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge as UiBadge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge, Button, Card, CardHeader, SelectInput, TextArea, TextInput } from "@/shared/components/ui";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import {
  allRequirementAnalysisChecklistItemIds,
  requirementAnalysisChecklistOptions,
  type RequirementAnalysisChecklistItemId,
} from "@/modules/requirement-analysis/checklist-options";
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

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type RequirementFinding = {
  id: string;
  checklistItemId: RequirementAnalysisChecklistItemId;
  issueType: string;
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
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  resolvedContextUsed?: unknown[];
};

type GeneratedTestCase = {
  id: string;
  title: string;
  description: string;
  priority: 1 | 2 | 3 | 4;
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
  options?: TestDesignOptions;
};

type WorkflowMode = "auto" | "manual";

type ManualPromptDraft = {
  prompt: string;
  promptVersion: string;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  options?: TestDesignOptions;
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

type ProjectUser = {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
};

type ExistingLinkedTestCase = {
  id: string;
  title: string;
  testType?: string;
  automationSuitability?: string;
  steps?: unknown[];
};

type ExistingTraceabilityRow = {
  id: string;
  sourceType: "story" | "description" | "acceptanceCriteria" | "businessRules";
  sourceReference: string;
  requirementText: string;
  coverageStatus: "Covered" | "Partially covered" | "Not covered" | "Needs review";
  severity: "High" | "Medium" | "Low";
  linkedTestCaseIds: string[];
  evidenceSummary: string;
  missingCoverage: string;
  recommendedMinimumTestCount: number;
  recommendedAction: string;
};

type ExistingReviewInsight = {
  id: string;
  severity: "High" | "Medium" | "Low";
  title: string;
  explanation: string;
  relatedMatrixRowIds: string[];
  relatedTestCaseIds: string[];
  suggestedAction: string;
};

type ExistingReviewFinding = {
  id: string;
  severity: "High" | "Medium" | "Low";
  category: string;
  title: string;
  explanation: string;
  relatedMatrixRowIds?: string[];
  relatedTestCaseIds?: string[];
  suggestedAction: string;
};

type ExistingReviewResult = {
  summary: string;
  coverageScore: number;
  traceabilityMatrix: ExistingTraceabilityRow[];
  insights: ExistingReviewInsight[];
  linkedTestCases: ExistingLinkedTestCase[];
  findings: ExistingReviewFinding[];
  suggestedAdditions: GeneratedTestCase[];
  contextUsed: string[];
};

type PublishRunResult = {
  results: Array<{
    localId: string;
    azureTestCaseId?: string;
    success: boolean;
    create?: { success: boolean; error?: string };
    link?: { success: boolean; error?: string };
    suite?: { success: boolean; suiteId?: string; suiteName?: string; error?: string };
    error?: string;
  }>;
  requirementSuite?: { success: boolean; suiteId?: string; suiteName?: string; error?: string };
};

type SuggestedAdditionsPublishResult = {
  results: Array<{
    localId: string;
    azureTestCaseId?: string;
    success: boolean;
    create?: { success: boolean; error?: string };
    link?: { success: boolean; error?: string };
    error?: string;
  }>;
};

type StoredGeneratedCasesPayload = {
  targetWorkItemId?: string;
  testCases?: GeneratedTestCase[];
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

function extractAzureId(value: string, kind: "plan" | "suite") {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const queryPattern = kind === "plan" ? /[?&]planId=(\d+)/i : /[?&]suiteId=(\d+)/i;
  const pathPattern = kind === "plan" ? /\/plans\/(\d+)(?:\/|$|\?)/i : /\/suites\/(\d+)(?:\/|$|\?)/i;
  return trimmed.match(queryPattern)?.[1] ?? trimmed.match(pathPattern)?.[1] ?? "";
}

function readStoredGeneratedCasesPayload(): StoredGeneratedCasesPayload {
  const previous = window.localStorage.getItem("itestflow.generatedTestCases");
  try {
    return previous ? (JSON.parse(previous) as StoredGeneratedCasesPayload) : {};
  } catch {
    return {};
  }
}

function writeStoredGeneratedCasesPayload(payload: StoredGeneratedCasesPayload) {
  window.localStorage.setItem("itestflow.generatedTestCases", JSON.stringify(payload));
}

function buildManualGeneratedTestCase(existingCases: GeneratedTestCase[]): GeneratedTestCase {
  const manualNumbers = existingCases
    .map((testCase) => testCase.id.match(/^TC-MANUAL-(\d+)$/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => Number(value));
  let nextNumber = Math.max(0, ...manualNumbers) + 1;
  let id = `TC-MANUAL-${String(nextNumber).padStart(3, "0")}`;
  const existingIds = new Set(existingCases.map((testCase) => testCase.id));
  while (existingIds.has(id)) {
    nextNumber += 1;
    id = `TC-MANUAL-${String(nextNumber).padStart(3, "0")}`;
  }

  return {
    id,
    title: "New manual test case",
    description: "Manual test case draft.",
    priority: 2,
    type: "regression",
    category: "manual",
    tags: [],
    relatedAcceptanceCriteria: [],
    relatedBusinessRules: [],
    relatedModules: [],
    preconditions: "Required setup is available.",
    testData: "",
    steps: [
      {
        stepNumber: 1,
        action: "Preconditions:\n1. Required setup is available",
        expectedResult: "Preconditions are met",
      },
    ],
  };
}

function normalizeTestCasePriority(value: unknown): GeneratedTestCase["priority"] {
  if (value === 1 || value === "1" || value === "critical") return 1;
  if (value === 2 || value === "2" || value === "high") return 2;
  if (value === 3 || value === "3" || value === "medium") return 3;
  if (value === 4 || value === "4" || value === "low") return 4;
  return 2;
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

function checklistItemTitle(checklistItemId: RequirementAnalysisChecklistItemId) {
  return requirementAnalysisChecklistOptions.find((checklistItem) => checklistItem.id === checklistItemId)?.title ?? formatEnumLabel(checklistItemId);
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

function initialsFromName(value?: string) {
  if (!value) return "AD";
  const words = value.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "AD";
}

function projectUserLabel(user: ProjectUser) {
  return user.uniqueName ? `${user.displayName} (${user.uniqueName})` : user.displayName;
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
  const [enabledChecklistItemIds, setEnabledChecklistItemIds] = useState<RequirementAnalysisChecklistItemId[]>(() => [...allRequirementAnalysisChecklistItemIds]);
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
  const [projectUsersState, setProjectUsersState] = useState<ApiState<ProjectUser[]>>({ loading: false, error: null, data: [] });
  const [selectedMentionUserIds, setSelectedMentionUserIds] = useState<string[]>([]);
  const sortedFindingList = useMemo(
    () => [...(analysis.data?.findings ?? [])].sort((left, right) => severityRank(left.severity) - severityRank(right.severity)),
    [analysis.data],
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
    setTargetWorkItemId(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
    setSelectedMentionUserIds([]);
  }

  function resetManualDraftForChecklistChange() {
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function changeChecklistSelection(checklistItemId: RequirementAnalysisChecklistItemId, checked: boolean) {
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
    setEnabledChecklistItemIds([...allRequirementAnalysisChecklistItemIds]);
    resetManualDraftForChecklistChange();
  }

  function clearAllChecklistItems() {
    setEnabledChecklistItemIds([]);
    resetManualDraftForChecklistChange();
  }

  function applyAnalysisResult(data: RequirementAnalysisRunResult) {
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
    if (!scope || !targetWorkItemId || !checklistSelectionValid) return;
    setAnalysis({ loading: true, error: null, data: null });
    try {
      const data = await postJson<RequirementAnalysisRunResult>(
        "/api/requirement-analysis/run",
        { scope, targetWorkItemId, enabledChecklistItemIds },
      );
      applyAnalysisResult(data);
    } catch (error) {
      setAnalysis({ loading: false, error: error instanceof Error ? error.message : "Requirement analysis failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !checklistSelectionValid) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/requirement-analysis/manual/draft", {
        scope,
        targetWorkItemId,
        enabledChecklistItemIds,
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

  function changeMentionUsers(userIds: string[]) {
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
              <Button onClick={runAnalysis} disabled={!scope || !targetWorkItemId || analysis.loading || !checklistSelectionValid}>
                <Play className="h-4 w-4" />
                {analysis.loading ? "Analyzing..." : "Analyze"}
              </Button>
            ) : (
              <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || manualDraft.loading || !checklistSelectionValid}>
                <Play className="h-4 w-4" />
                {manualDraft.loading ? "Preparing..." : "Prepare Prompt"}
              </Button>
            )}
          </div>
          <RequirementChecklistSelector
            selectedIds={enabledChecklistItemIds}
            onToggle={changeChecklistSelection}
            onSelectAll={selectAllChecklistItems}
            onClearAll={clearAllChecklistItems}
          />
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
                <div key={finding.id} className="grid gap-4 p-4 xl:grid-cols-[32px_240px_minmax(0,1fr)_minmax(260px,0.85fr)]">
                  <input
                    type="checkbox"
                    checked={Boolean(selectedFindings[finding.id])}
                    onChange={(event) => changeFindingSelection(finding.id, event.target.checked)}
                    className="mt-2 h-4 w-4"
                    aria-label={`Select ${finding.id}`}
                  />
                  <div>
                    <Badge tone={severityTone(finding.severity)}>{formatEnumLabel(finding.severity)}</Badge>
                    <div className="mt-2 text-xs font-medium text-slate-600">{checklistItemTitle(finding.checklistItemId)}</div>
                    <div className="mt-1 text-xs text-slate-500">Issue Type: {formatEnumLabel(finding.issueType)}</div>
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
            <RequirementMentionPicker
              users={projectUsers}
              selectedUserIds={selectedMentionUserIds}
              selectedUsers={selectedMentionUsers}
              loading={projectUsersState.loading}
              error={projectUsersState.error}
              disabled={!scope}
              onSelectionChange={changeMentionUsers}
            />
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
  const [open, setOpen] = useState(false);
  const selectedIdSet = useMemo(() => new Set(selectedUserIds), [selectedUserIds]);
  const triggerLabel = loading ? "Loading members" : selectedUsers.length ? `${selectedUsers.length} selected` : "Mention members";

  function setUserSelected(userId: string, selected: boolean) {
    const nextIds = selected
      ? [...selectedUserIds, userId].filter((value, index, values) => values.indexOf(value) === index)
      : selectedUserIds.filter((value) => value !== userId);
    onSelectionChange(nextIds);
  }

  function toggleUser(userId: string) {
    setUserSelected(userId, !selectedIdSet.has(userId));
  }

  return (
    <div className="rounded-md border border-[#c8d4e4] bg-white p-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-950">Mention members</div>
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
          {error ? <div className="mt-2 text-xs text-red-700">{error}</div> : null}
        </div>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="secondary" disabled={disabled} className="w-full justify-between lg:w-auto">
              <span className="inline-flex items-center gap-2">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
                {triggerLabel}
              </span>
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[360px] max-w-[calc(100vw-2rem)] p-0">
            <Command>
              <CommandInput placeholder="Search project users" />
              <CommandList>
                {loading ? (
                  <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading project users
                  </div>
                ) : null}
                {!loading && error ? <div className="px-3 py-4 text-sm text-red-700">{error}</div> : null}
                {!loading && !error ? (
                  <>
                    <CommandEmpty>No project users found.</CommandEmpty>
                    <CommandGroup>
                      {users.map((user) => {
                        const selected = selectedIdSet.has(user.id);
                        return (
                          <CommandItem
                            key={user.id}
                            value={projectUserLabel(user)}
                            onSelect={() => toggleUser(user.id)}
                            className="items-start gap-3 py-2"
                          >
                            <Checkbox
                              checked={selected}
                              onClick={(event) => event.stopPropagation()}
                              onCheckedChange={(checked) => setUserSelected(user.id, checked === true)}
                              aria-label={`Mention ${user.displayName}`}
                              className="mt-2"
                            />
                            <Avatar size="sm" className="mt-0.5">
                              {user.imageUrl ? <AvatarImage src={user.imageUrl} alt="" /> : null}
                              <AvatarFallback>{initialsFromName(user.displayName)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-foreground">{user.displayName}</div>
                              {user.uniqueName ? <div className="truncate text-xs text-muted-foreground">{user.uniqueName}</div> : null}
                            </div>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </>
                ) : null}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}

export function TestCaseGenerationClient() {
  const scope = useActiveProject();
  const generatedCasesRef = useRef<HTMLDivElement | null>(null);
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [mode, setMode] = useState<WorkflowMode>("auto");
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

  function changeTargetWorkItemId(value: string) {
    setTargetWorkItemId(value);
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
    writeStoredGeneratedCasesPayload({ targetWorkItemId, testCases: data.testCases });
  }

  async function generate() {
    if (!scope || !targetWorkItemId || !testDesignOptionsValid) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<TestCaseGenerationRunResult>("/api/test-cases/generate", {
        scope,
        targetWorkItemId,
        options: buildTestDesignOptionsRequest(),
      });
      applyGeneratedCases(data);
      scrollToNextStep(generatedCasesRef);
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Test case generation failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId || !testDesignOptionsValid) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/test-cases/manual/draft", {
        scope,
        targetWorkItemId,
        options: buildTestDesignOptionsRequest(),
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
              <Button onClick={generate} disabled={!scope || !targetWorkItemId || state.loading || !testDesignOptionsValid}>
                <Play className="h-4 w-4" />
                {state.loading ? "Generating..." : "Generate"}
              </Button>
            ) : (
              <Button onClick={prepareManualPrompt} disabled={!scope || !targetWorkItemId || manualDraft.loading || !testDesignOptionsValid}>
                <Play className="h-4 w-4" />
                {manualDraft.loading ? "Preparing..." : "Prepare Prompt"}
              </Button>
            )}
          </div>
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
      <div ref={generatedCasesRef} className="space-y-6">
        {state.data || testCases.length ? (
          <>
            <EditableGeneratedCases testCases={testCases} setTestCases={setTestCases} targetWorkItemId={targetWorkItemId} />
            <PublishGeneratedCasesPanel scope={scope} targetWorkItemId={targetWorkItemId} testCases={testCases} />
          </>
        ) : (
          <EmptyBlock message="No generated test cases yet. Run generation against a real Azure DevOps work item." />
        )}
      </div>
    </div>
  );
}

export function ExistingTestCaseReviewClient() {
  const scope = useActiveProject();
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [state, setState] = useState<ApiState<ExistingReviewResult>>({ loading: false, error: null, data: null });
  const [manualDraft, setManualDraft] = useState<ApiState<ManualPromptDraft>>({ loading: false, error: null, data: null });
  const [manualResponse, setManualResponse] = useState("");
  const [manualSubmitLoading, setManualSubmitLoading] = useState(false);
  const [manualSubmitError, setManualSubmitError] = useState<string | null>(null);

  function changeTargetWorkItemId(value: string) {
    setTargetWorkItemId(value);
    setManualDraft({ loading: false, error: null, data: null });
    setManualResponse("");
    setManualSubmitError(null);
  }

  function applyReviewResult(data: ExistingReviewResult) {
    setState({ loading: false, error: null, data });
    writeStoredGeneratedCasesPayload({ targetWorkItemId, testCases: data.suggestedAdditions });
  }

  function updateSuggestedAdditions(testCases: GeneratedTestCase[]) {
    setState((current) => ({
      ...current,
      data: current.data ? { ...current.data, suggestedAdditions: testCases } : current.data,
    }));
  }

  async function review() {
    if (!scope || !targetWorkItemId) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<ExistingReviewResult>("/api/existing-test-case-review/run", {
        scope,
        targetWorkItemId,
      });
      applyReviewResult(data);
      scrollToNextStep(resultsRef);
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Test Coverage Matrix generation failed.", data: null });
    }
  }

  async function prepareManualPrompt() {
    if (!scope || !targetWorkItemId) return;
    setManualDraft({ loading: true, error: null, data: null });
    setManualSubmitError(null);
    setManualResponse("");
    try {
      const data = await postJson<ManualPromptDraft>("/api/existing-test-case-review/manual/draft", {
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
      const data = await postJson<ExistingReviewResult>("/api/existing-test-case-review/manual/submit", {
        scope,
        targetWorkItemId,
        rawOutput: manualResponse,
        selectedContextIds: manualDraft.data.selectedContextIds ?? [],
        resolvedContextUsed: manualDraft.data.resolvedContextUsed ?? [],
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
      <Card>
        <CardHeader
          title="Test Coverage Matrix"
          description="Enter a user story ID. Linked test cases and project context are selected automatically for this run."
          action={<WorkflowModeTabs mode={mode} onChange={setMode} />}
        />
        <div className="space-y-4 p-4">
          <div className="grid gap-4 lg:grid-cols-[240px_auto]">
            <TextInput value={targetWorkItemId} onChange={(event) => changeTargetWorkItemId(event.target.value)} placeholder="User story ID" />
            {mode === "auto" ? (
              <Button onClick={review} disabled={!scope || !targetWorkItemId || state.loading}>
                <Play className="h-4 w-4" />
                {state.loading ? "Reviewing..." : "Auto Generate"}
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
      <div ref={resultsRef} className="space-y-6">
        {state.data ? (
          <>
            <ExistingTraceabilitySummary result={state.data} />
            <ExistingTraceabilityMatrix rows={state.data.traceabilityMatrix} />
            <ExistingReviewInsights insights={state.data.insights} findings={state.data.findings} />
            <ExistingLinkedTestCasesList linkedTestCases={state.data.linkedTestCases} />
            {state.data.suggestedAdditions.length ? (
              <>
                <EditableGeneratedCases
                  testCases={state.data.suggestedAdditions}
                  setTestCases={updateSuggestedAdditions}
                  title="Suggested Additions"
                  targetWorkItemId={targetWorkItemId}
                  caseActions={false}
                  allowDelete
                />
                <SuggestedAdditionsPublishPanel
                  scope={scope}
                  targetWorkItemId={targetWorkItemId}
                  testCases={state.data.suggestedAdditions}
                />
              </>
            ) : (
              <EmptyBlock message="No draft additions were suggested. The current linked test cases may already cover the reviewed points, or only clarification is needed." />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ExistingTraceabilitySummary({ result }: { result: ExistingReviewResult }) {
  const counts = countTraceabilityStatuses(result.traceabilityMatrix);
  const gapCount = counts["Partially covered"] + counts["Not covered"] + counts["Needs review"];
  const metrics = [
    { title: "Coverage Score", value: formatPercentage(result.coverageScore), tone: scoreTone(result.coverageScore) },
    { title: "Coverage Points", value: String(result.traceabilityMatrix.length), tone: "blue" as const },
    { title: "Covered", value: String(counts.Covered), tone: "emerald" as const },
    { title: "Gaps", value: String(gapCount), tone: gapCount ? "red" as const : "emerald" as const },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        {metrics.map((metric) => (
          <CoverageMetric key={metric.title} label={metric.title} value={metric.value} tone={metric.tone} />
        ))}
      </div>
      <Card className="p-4">
        <div className="text-sm font-semibold text-slate-950">Review Summary</div>
        <p className="mt-2 text-sm leading-6 text-slate-600">{result.summary}</p>
      </Card>
    </div>
  );
}

function CoverageMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "emerald" | "amber" | "red" | "blue";
}) {
  const toneStyles = {
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-700",
    amber: "border-amber-200 bg-amber-50 text-amber-700",
    red: "border-red-200 bg-red-50 text-red-700",
    blue: "border-blue-200 bg-blue-50 text-blue-700",
  }[tone];

  return (
    <div className={`rounded-md border p-4 ${toneStyles}`}>
      <div className="text-base font-semibold text-slate-600">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

function ExistingTraceabilityMatrix({ rows }: { rows: ExistingTraceabilityRow[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Test Coverage Matrix" description="Every row is one atomic coverage point mapped to linked Azure DevOps test cases." />
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-left text-sm">
            <thead className="bg-[#f8fafc] text-xs uppercase tracking-normal text-slate-500">
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
            <tbody className="divide-y divide-[#d8e2ef]">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-4">
                    <div className="font-mono text-xs font-semibold text-blue-600">{row.id}</div>
                    <Badge tone={severityTone(row.severity)} className="mt-2">{row.severity}</Badge>
                  </td>
                  <td className="px-4 py-4">
                    <div className="font-medium text-slate-950">{coverageSourceLabel(row.sourceType)}</div>
                    <div className="mt-1 text-xs text-slate-500">{row.sourceReference}</div>
                  </td>
                  <td className="max-w-[320px] px-4 py-4 text-slate-700">
                    <p className="break-words leading-6">{row.requirementText}</p>
                    {row.missingCoverage ? <p className="mt-2 text-xs leading-5 text-red-600">{row.missingCoverage}</p> : null}
                  </td>
                  <td className="px-4 py-4">
                    <Badge tone={coverageTone(row.coverageStatus)}>{row.coverageStatus}</Badge>
                    <div className="mt-2 text-xs text-slate-500">Min tests: {row.recommendedMinimumTestCount}</div>
                  </td>
                  <td className="px-4 py-4">
                    {row.linkedTestCaseIds.length ? (
                      <div className="flex max-w-[180px] flex-wrap gap-1">
                        {row.linkedTestCaseIds.map((id) => <Badge key={id} tone="blue">{id}</Badge>)}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500">No linked case</span>
                    )}
                  </td>
                  <td className="max-w-[260px] px-4 py-4 text-slate-600">
                    <p className="break-words leading-6">{row.evidenceSummary || "No evidence supplied."}</p>
                  </td>
                  <td className="max-w-[260px] px-4 py-4 text-blue-600">
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
    </Card>
  );
}

function ExistingReviewInsights({ insights, findings }: { insights: ExistingReviewInsight[]; findings: ExistingReviewFinding[] }) {
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader title="Coverage Insights" />
        {insights.length ? (
          <div className="divide-y divide-[#d8e2ef]">
            {insights.map((insight) => (
              <div key={insight.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={severityTone(insight.severity)}>{insight.severity}</Badge>
                  <span className="font-medium text-slate-950">{insight.title}</span>
                </div>
                <p className="mt-2 text-sm leading-6 text-slate-600">{insight.explanation}</p>
                <p className="mt-2 text-sm leading-6 text-blue-600">{insight.suggestedAction}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBlock message="No additional insights were returned." />
        )}
      </Card>
      <Card>
        <CardHeader title="Review Findings" />
        {findings.length ? (
          <div className="divide-y divide-[#d8e2ef]">
            {findings.map((finding) => (
              <div key={finding.id} className="grid gap-3 p-4 md:grid-cols-[120px_1fr]">
                <Badge tone={severityTone(finding.severity)} className="self-start justify-self-start whitespace-nowrap">{finding.severity}</Badge>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-950">{finding.title}</span>
                    <Badge tone="slate">{finding.category}</Badge>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{finding.explanation}</p>
                  <p className="mt-2 text-sm leading-6 text-blue-600">{finding.suggestedAction}</p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyBlock message="No review findings were returned." />
        )}
      </Card>
    </div>
  );
}

function ExistingLinkedTestCasesList({ linkedTestCases }: { linkedTestCases: ExistingLinkedTestCase[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <CardHeader
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
      />
      {open && linkedTestCases.length ? (
        <div className="divide-y divide-[#d8e2ef]">
          {linkedTestCases.map((testCase) => (
            <div key={testCase.id} className="grid gap-3 p-4 md:grid-cols-[140px_1fr_120px]">
              <span className="font-mono text-xs text-blue-600">{testCase.id}</span>
              <div>
                <div className="font-medium text-slate-950">{testCase.title}</div>
                <div className="mt-1 text-xs text-slate-500">{testCase.testType ?? "Test Case"}</div>
              </div>
              <span className="text-sm text-slate-600">{testCase.steps?.length ?? 0} steps</span>
            </div>
          ))}
        </div>
      ) : open ? (
        <EmptyBlock message="No TestedBy / Tests linked Azure DevOps test cases were found for this story." />
      ) : null}
    </Card>
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

function coverageTone(status: ExistingTraceabilityRow["coverageStatus"]) {
  if (status === "Covered") return "emerald" as const;
  if (status === "Partially covered") return "amber" as const;
  if (status === "Not covered") return "red" as const;
  return "violet" as const;
}

function coverageSourceLabel(sourceType: ExistingTraceabilityRow["sourceType"]) {
  if (sourceType === "businessRules") return "Business Rules";
  if (sourceType === "acceptanceCriteria") return "Acceptance Criteria";
  if (sourceType === "description") return "Description";
  return "Story";
}

function SuggestedAdditionsPublishPanel({
  scope,
  targetWorkItemId,
  testCases,
}: {
  scope: ActiveProjectScope | null;
  targetWorkItemId: string;
  testCases: GeneratedTestCase[];
}) {
  const [state, setState] = useState<ApiState<SuggestedAdditionsPublishResult>>({ loading: false, error: null, data: null });

  async function publish() {
    if (!scope || !targetWorkItemId || !testCases.length || state.loading) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<SuggestedAdditionsPublishResult>("/api/test-coverage-matrix/suggested-additions/publish", {
        scope,
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
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Suggested additions publish failed.", data: null });
    }
  }

  const disabled = !scope || !targetWorkItemId || !testCases.length || state.loading;

  return (
    <Card>
      <CardHeader
        title="Add Suggested Additions to Azure"
        description="Create the suggested Azure Test Case work items and link them to the selected user story."
      />
      <div className="space-y-4 p-4">
        {state.error ? <ErrorBlock message={state.error} /> : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm leading-6 text-slate-600">
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
    </Card>
  );
}

function SuggestedAdditionsPublishResultSummary({ data }: { data: SuggestedAdditionsPublishResult }) {
  const successCount = data.results.filter((result) => result.success).length;
  return (
    <div className="rounded-md border border-[#c8d4e4] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div className="text-sm font-semibold text-slate-950">
          Azure Add Results: {successCount} of {data.results.length} created and linked
        </div>
        <Badge tone={successCount === data.results.length ? "emerald" : "amber"}>
          {successCount === data.results.length ? "Complete" : "Partial"}
        </Badge>
      </div>
      <div className="divide-y">
        {data.results.map((result) => (
          <div key={result.localId} className="grid gap-3 p-3 text-sm lg:grid-cols-[140px_140px_140px_minmax(0,1fr)]">
            <span className="font-mono text-xs text-blue-600">{result.localId}</span>
            <span>{result.azureTestCaseId ? `Azure ${result.azureTestCaseId}` : "Not created"}</span>
            <StatusText label="Create" success={result.create?.success} error={result.create?.error ?? result.error} />
            <StatusText label="Link" success={result.link?.success} error={result.link?.error} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PublishGeneratedCasesPanel({
  scope,
  targetWorkItemId,
  testCases,
}: {
  scope: ActiveProjectScope | null;
  targetWorkItemId: string;
  testCases: GeneratedTestCase[];
}) {
  const [testPlanInput, setTestPlanInput] = useState("");
  const [parentSuiteInput, setParentSuiteInput] = useState("");
  const [createRequirementSuite, setCreateRequirementSuite] = useState(false);
  const [testPlans, setTestPlans] = useState<TestPlan[]>([]);
  const [testSuites, setTestSuites] = useState<TestSuite[]>([]);
  const [planError, setPlanError] = useState<string | null>(null);
  const [state, setState] = useState<ApiState<PublishRunResult>>({ loading: false, error: null, data: null });
  const selectedTestPlanId = useMemo(() => extractAzureId(testPlanInput, "plan"), [testPlanInput]);
  const selectedSuiteId = useMemo(() => extractAzureId(parentSuiteInput, "suite"), [parentSuiteInput]);
  const selectedPlanLabel = testPlans.find((plan) => plan.id === selectedTestPlanId);
  const selectedSuiteLabel = testSuites.find((suite) => suite.id === selectedSuiteId);
  const targetControlsDisabled = !createRequirementSuite;

  useEffect(() => {
    if (!scope) return;
    setPlanError(null);
    postJson<{ testPlans: TestPlan[] }>("/api/azure-devops/test-plans", { scope })
      .then((data) => setTestPlans(data.testPlans))
      .catch((error: unknown) => setPlanError(error instanceof Error ? error.message : "Azure Test Plan fetch failed."));
  }, [scope]);

  useEffect(() => {
    if (!scope || !selectedTestPlanId || !createRequirementSuite) {
      setTestSuites([]);
      return;
    }
    setPlanError(null);
    postJson<{ testSuites: TestSuite[] }>("/api/azure-devops/test-suites", { scope, testPlanId: selectedTestPlanId })
      .then((data) => setTestSuites(data.testSuites))
      .catch((error: unknown) => setPlanError(error instanceof Error ? error.message : "Azure Test Suite fetch failed."));
  }, [scope, selectedTestPlanId, createRequirementSuite]);

  function selectPlan(value: string) {
    setTestPlanInput(value);
    setParentSuiteInput("");
    setState({ loading: false, error: null, data: null });
  }

  function selectSuite(value: string) {
    setParentSuiteInput(value);
    setState({ loading: false, error: null, data: null });
  }

  async function publish() {
    if (!scope || !targetWorkItemId || !createRequirementSuite || !selectedTestPlanId || !selectedSuiteId || !testCases.length) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<PublishRunResult>("/api/publish/test-cases", {
        scope,
        targetWorkItemId,
        testPlanId: testPlanInput,
        suiteMode: "requirement",
        parentSuiteId: parentSuiteInput,
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
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Publish failed.", data: null });
    }
  }

  const disabled =
    !scope ||
    !targetWorkItemId ||
    !createRequirementSuite ||
    !selectedTestPlanId ||
    !selectedSuiteId ||
    !testCases.length ||
    state.loading;

  return (
    <Card>
      <CardHeader
        title="Publish Generated Test Cases"
        description="Create Azure Test Case work items, link them to the user story, then add them to a suite or create a requirement-based suite."
      />
      <div className="space-y-4 p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            checked={createRequirementSuite}
            onChange={(event) => {
              setCreateRequirementSuite(event.target.checked);
              setState({ loading: false, error: null, data: null });
            }}
            className="h-4 w-4"
            aria-label="Create requirement-based suite for this user story"
          />
          Create requirement-based suite for this user story
        </label>

        <div className={`space-y-4 transition ${targetControlsDisabled ? "opacity-50" : "opacity-100"}`}>
          <div className="grid gap-3 lg:grid-cols-2">
            <SelectInput
              value={selectedTestPlanId}
              onChange={(event) => selectPlan(event.target.value)}
              disabled={targetControlsDisabled}
              aria-label="Select Azure Test Plan"
            >
              <option value="">Select Azure Test Plan</option>
              {testPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.id} - {plan.name}
                </option>
              ))}
            </SelectInput>
            <TextInput
              value={testPlanInput}
              onChange={(event) => selectPlan(event.target.value)}
              placeholder="Or paste Test Plan ID/link"
              disabled={targetControlsDisabled}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <SelectInput
              value={selectedSuiteId}
              onChange={(event) => selectSuite(event.target.value)}
              disabled={targetControlsDisabled || !selectedTestPlanId}
              aria-label="Select Parent Suite"
            >
              <option value="">Select Parent Suite</option>
              {testSuites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.id} - {suite.name}
                </option>
              ))}
            </SelectInput>
            <TextInput
              value={parentSuiteInput}
              onChange={(event) => selectSuite(event.target.value)}
              placeholder="Or paste Parent Suite ID/link"
              disabled={targetControlsDisabled}
            />
          </div>
        </div>

        {planError ? <ErrorBlock message={planError} /> : null}
        {state.error ? <ErrorBlock message={state.error} /> : null}

        <div className="flex justify-end">
          <ConfirmationDialog
            trigger={
              <Button disabled={disabled}>
                {state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {state.loading ? "Publishing..." : `Publish ${testCases.length || ""}`}
              </Button>
            }
            title="Publish generated test cases?"
            description={
              <div className="space-y-1">
                <p>Project: {scope?.azureProjectName ?? "Selected Azure DevOps project"}</p>
                <p>User story: {targetWorkItemId}</p>
                <p>Test cases: {testCases.length}</p>
                <p>Test plan: {selectedPlanLabel ? `${selectedPlanLabel.id} - ${selectedPlanLabel.name}` : selectedTestPlanId}</p>
                <p>Parent suite: {selectedSuiteLabel ? `${selectedSuiteLabel.id} - ${selectedSuiteLabel.name}` : selectedSuiteId}</p>
              </div>
            }
            confirmLabel="Publish cases"
            onConfirm={publish}
          />
        </div>

        {state.data ? <PublishResultSummary data={state.data} /> : null}
      </div>
    </Card>
  );
}

function PublishResultSummary({ data }: { data: PublishRunResult }) {
  const successCount = data.results.filter((result) => result.success).length;
  return (
    <div className="rounded-md border border-[#c8d4e4] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <div className="text-sm font-semibold text-slate-950">
          Publish Results: {successCount} of {data.results.length} completed
        </div>
        {data.requirementSuite ? (
          <Badge tone={data.requirementSuite.success ? "emerald" : "red"}>
            {data.requirementSuite.success
              ? `Suite ${data.requirementSuite.suiteId ?? ""}`.trim()
              : "Suite failed"}
          </Badge>
        ) : null}
      </div>
      <div className="divide-y">
        {data.results.map((result) => (
          <div key={result.localId} className="grid gap-3 p-3 text-sm lg:grid-cols-[140px_120px_120px_120px_minmax(0,1fr)]">
            <span className="font-mono text-xs text-blue-600">{result.localId}</span>
            <span>{result.azureTestCaseId ? `Azure ${result.azureTestCaseId}` : "Not created"}</span>
            <StatusText label="Create" success={result.create?.success} error={result.create?.error ?? result.error} />
            <StatusText label="Link" success={result.link?.success} error={result.link?.error} />
            <StatusText
              label="Suite"
              success={result.suite?.success}
              error={result.suite?.error}
              detail={result.suite?.suiteName ?? result.suite?.suiteId}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusText({
  label,
  success,
  error,
  detail,
}: {
  label: string;
  success?: boolean;
  error?: string;
  detail?: string;
}) {
  const tone = success ? "text-emerald-700" : "text-red-700";
  return (
    <div className={tone}>
      <span className="font-medium">{label}: </span>
      {success ? detail ?? "Done" : error ?? "Failed"}
    </div>
  );
}

export function PublishTestCasesClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);

  useEffect(() => {
    const parsed = readStoredGeneratedCasesPayload();
    setTargetWorkItemId(parsed.targetWorkItemId ?? "");
    setTestCases(parsed.testCases ?? []);
  }, []);

  function changeTargetWorkItemId(value: string) {
    setTargetWorkItemId(value);
    writeStoredGeneratedCasesPayload({ ...readStoredGeneratedCasesPayload(), targetWorkItemId: value, testCases });
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader title="Target User Story" />
        <div className="p-4">
          <TextInput value={targetWorkItemId} onChange={(event) => changeTargetWorkItemId(event.target.value)} placeholder="Target user story ID" />
        </div>
      </Card>
      <EditableGeneratedCases
        testCases={testCases}
        setTestCases={setTestCases}
        title="Cases Ready to Publish"
        targetWorkItemId={targetWorkItemId}
      />
      <PublishGeneratedCasesPanel scope={scope} targetWorkItemId={targetWorkItemId} testCases={testCases} />
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
    <div className="rounded-md border border-[#c8d4e4] bg-[#f8fafc] p-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(240px,320px)_1fr]">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-semibold text-slate-950">Target Test Case Range</div>
            <div className="mt-2">
              <SelectInput
                value={settings.targetTestCaseRange}
                onChange={(event) => onTargetRangeChange(event.target.value as TargetTestCaseRangeId)}
              >
                {targetTestCaseRangeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.id === "custom" ? option.label : `${option.label} (${option.minCases}-${option.maxCases})`}
                  </option>
                ))}
              </SelectInput>
            </div>
          </div>

          {settings.targetTestCaseRange === "custom" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-600">
                Minimum
                <TextInput
                  type="number"
                  min={1}
                  max={maxCustomTestCaseRange}
                  value={settings.customMinCases ?? ""}
                  onChange={(event) => onCustomRangeChange("customMinCases", event.target.value)}
                  className="mt-1"
                />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Maximum
                <TextInput
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
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Custom range must be between 1 and {maxCustomTestCaseRange}, with minimum not greater than maximum.
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold text-slate-950">Coverage Focus Rules</div>
              <div className="text-xs text-slate-500">
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
                  className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-blue-200 hover:bg-blue-50"
                >
                  <Checkbox checked={checked} onCheckedChange={(value) => onCoverageFocusToggle(focusItem.id, value === true)} aria-label={focusItem.title} />
                  <span className="leading-5">{focusItem.title}</span>
                </label>
              );
            })}
          </div>

          {!coverageFocusSelectionValid ? (
            <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Select at least one Coverage Focus item to generate or prepare the external LLM prompt.
            </div>
          ) : null}
        </div>
      </div>
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
    <div className="rounded-md border border-[#c8d4e4] bg-[#f8fafc] p-4">
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-950">Requirement Analysis Checklist</div>
          <div className="text-xs text-slate-500">
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
              className="flex min-h-12 cursor-pointer items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 transition hover:border-blue-200 hover:bg-blue-50"
            >
              <Checkbox checked={checked} onCheckedChange={(value) => onToggle(checklistItem.id, value === true)} aria-label={checklistItem.title} />
              <span className="leading-5">{checklistItem.title}</span>
            </label>
          );
        })}
      </div>

      {noneSelected ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Select at least one checklist item to run analysis or prepare the external LLM prompt.
        </div>
      ) : null}
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
  targetWorkItemId,
  caseActions = true,
  allowDelete = caseActions,
  allowAdd = caseActions,
}: {
  testCases: GeneratedTestCase[];
  setTestCases: (testCases: GeneratedTestCase[]) => void;
  title?: string;
  targetWorkItemId?: string;
  caseActions?: boolean;
  allowDelete?: boolean;
  allowAdd?: boolean;
}) {
  const testCaseStats = useMemo(() => {
    const byPriority: Record<GeneratedTestCase["priority"], number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
    const byType: Record<string, number> = {};

    for (const testCase of testCases) {
      byPriority[testCase.priority] += 1;
      byType[testCase.type] = (byType[testCase.type] ?? 0) + 1;
    }

    return {
      total: testCases.length,
      byPriority,
      byType: Object.entries(byType).sort(([firstType], [secondType]) => firstType.localeCompare(secondType)),
    };
  }, [testCases]);
  const priorityBreakdown = useMemo<GeneratedCaseSummaryRow[]>(() =>
    ([1, 2, 3, 4] as const).map((priority) => ({
      label: `Priority ${priority}`,
      value: testCaseStats.byPriority[priority],
      tone: priority === 1 ? "red" : priority === 2 ? "amber" : priority === 3 ? "blue" : "slate",
    })),
  [testCaseStats]);
  const scopeBreakdown = useMemo<GeneratedCaseSummaryRow[]>(
    () => testCaseStats.byType.map(([type, count]) => ({ label: formatEnumLabel(type), value: count, tone: "cyan" as const })),
    [testCaseStats],
  );

  function persistCases(updated: GeneratedTestCase[]) {
    setTestCases(updated);
    const previousPayload = readStoredGeneratedCasesPayload();
    writeStoredGeneratedCasesPayload({
      ...previousPayload,
      targetWorkItemId: targetWorkItemId ?? previousPayload.targetWorkItemId,
      testCases: updated,
    });
  }

  function updateCase(index: number, next: GeneratedTestCase) {
    const updated = [...testCases];
    updated[index] = next;
    persistCases(updated);
  }

  function addCase() {
    persistCases([...testCases, buildManualGeneratedTestCase(testCases)]);
  }

  function deleteCase(index: number) {
    persistCases(testCases.filter((_, current) => current !== index));
  }

  return (
    <Card>
      <CardHeader
        title={title}
        description="Edit titles and steps inline before publishing."
      />
      <div className="grid gap-3 border-b border-[#d8e2ef] bg-[#f8fafc] p-4 lg:grid-cols-[180px_minmax(260px,1fr)_minmax(260px,1fr)]">
        <GeneratedCaseTotalCard total={testCaseStats.total} />
        <GeneratedCaseSummaryCard title="Priority Breakdown" rows={priorityBreakdown} />
        <GeneratedCaseSummaryCard
          title="Type"
          rows={scopeBreakdown}
          emptyLabel="No scope values yet"
        />
      </div>
      <div className="divide-y">
        {testCases.length ? testCases.map((testCase, index) => (
          <div key={testCase.id} className="space-y-3 p-4">
            <div className="grid gap-3 lg:grid-cols-[120px_1fr_160px_160px_42px]">
              <span className="font-mono text-xs text-blue-600">{testCase.id}</span>
              <TextInput value={testCase.title} onChange={(event) => updateCase(index, { ...testCase, title: event.target.value })} />
              <SelectInput
                value={testCase.priority}
                onChange={(event) => updateCase(index, { ...testCase, priority: Number(event.target.value) as GeneratedTestCase["priority"] })}
              >
                <option value={1}>1 - Highest</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4 - Lowest</option>
              </SelectInput>
              <Badge tone="cyan">{testCase.type}</Badge>
              {allowDelete ? (
                <Button variant="ghost" onClick={() => deleteCase(index)} aria-label={`Delete ${testCase.id}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
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
                    aria-label={`Delete step ${stepIndex + 1} from ${testCase.id}`}
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
        )) : (
          <div className="p-4">
            <div className="rounded-md border border-dashed border-[#c8d4e4] bg-[#f8fafc] p-5 text-sm text-slate-500">
              {allowAdd ? "No test cases in this list. Add a test case to continue." : "No test cases in this list."}
            </div>
          </div>
        )}
      </div>
      {allowAdd ? (
        <div className="flex justify-end border-t border-[#d8e2ef] px-5 py-4">
          <Button variant="secondary" onClick={addCase}>
            <Plus className="h-4 w-4" />
            Add Test Case
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

type GeneratedCaseSummaryRow = {
  label: string;
  value: number;
  tone: "red" | "amber" | "blue" | "cyan" | "slate";
};

function GeneratedCaseTotalCard({ total }: { total: number }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="text-base font-semibold text-slate-600">Total</div>
      <div className="mt-2 text-4xl font-bold text-slate-950">{total}</div>
    </div>
  );
}

function GeneratedCaseSummaryCard({
  title,
  rows,
  emptyLabel = "No values yet",
  footer,
}: {
  title: string;
  rows: GeneratedCaseSummaryRow[];
  emptyLabel?: string;
  footer?: React.ReactNode;
}) {
  const hasValues = rows.some((row) => row.value > 0);

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <div className="text-base font-semibold text-slate-600">{title}</div>
      {hasValues ? (
        <div className="mt-3 grid gap-2">
          {rows.map((row) => (
            <GeneratedCaseSummaryRowItem key={row.label} row={row} />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400">
          {emptyLabel}
        </div>
      )}
      {footer}
    </div>
  );
}

function GeneratedCaseSummaryRowItem({ row }: { row: GeneratedCaseSummaryRow }) {
  const toneStyles = {
    red: "bg-red-50 text-red-700",
    amber: "bg-amber-50 text-amber-700",
    blue: "bg-blue-50 text-blue-700",
    cyan: "bg-cyan-50 text-cyan-700",
    slate: "bg-slate-100 text-slate-700",
  }[row.tone];
  const empty = row.value === 0;

  return (
    <div className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${empty ? "bg-slate-50 text-slate-400" : toneStyles}`}>
      <span className={empty ? "text-slate-400" : "font-medium"}>{row.label}</span>
      <span className={empty ? "text-xs text-slate-400" : "text-base font-bold"}>{empty ? "None" : row.value}</span>
    </div>
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
