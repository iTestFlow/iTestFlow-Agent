"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Play, Send, Trash2 } from "lucide-react";
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
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [analysis, setAnalysis] = useState<ApiState<{ findings: RequirementFinding[]; summary: RequirementSummary; recommendations: string[]; contextUsed: string[]; resolvedContextUsed?: unknown[] }>>({
    loading: false,
    error: null,
    data: null,
  });
  const [selectedFindings, setSelectedFindings] = useState<Record<string, boolean>>({});
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const [reviewOpen, setReviewOpen] = useState(false);
  const [finalComment, setFinalComment] = useState("");
  const [reviewApproved, setReviewApproved] = useState(false);
  const [pushState, setPushState] = useState<ApiState<{ success: boolean }>>({ loading: false, error: null, data: null });
  const selectedFindingList = useMemo(
    () => analysis.data?.findings.filter((finding) => selectedFindings[finding.id]) ?? [],
    [analysis.data, selectedFindings],
  );

  async function runAnalysis() {
    if (!scope || !targetWorkItemId) return;
    setAnalysis({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ findings: RequirementFinding[]; summary: RequirementSummary; recommendations: string[]; contextUsed: string[]; resolvedContextUsed?: unknown[] }>(
        "/api/requirement-analysis/run",
        { scope, targetWorkItemId },
      );
      setAnalysis({ loading: false, error: null, data });
      setSelectedFindings(Object.fromEntries(data.findings.map((finding) => [finding.id, true])));
      setSnippets(Object.fromEntries(data.findings.map((finding) => [finding.id, finding.suggestion])));
      setReviewOpen(false);
      setFinalComment("");
      setReviewApproved(false);
      setPushState({ loading: false, error: null, data: null });
    } catch (error) {
      setAnalysis({ loading: false, error: error instanceof Error ? error.message : "Requirement analysis failed.", data: null });
    }
  }

  function buildCommentBody() {
    if (!scope || !targetWorkItemId || !analysis.data) return;
    return [
      `## iTestFlow Requirement Analysis for ${targetWorkItemId}`,
      analysis.data.summary.summaryText,
      ...selectedFindingList.map((finding) => [
        `### [${finding.severity.toUpperCase()}] ${finding.title}`,
        finding.description,
        `Risk: ${finding.riskLevel} - ${finding.riskJustification}`,
        `Suggested resolution: ${snippets[finding.id] ?? finding.suggestion}`,
      ].join("\n\n")),
    ].join("\n\n");
  }

  function openReview() {
    const commentBody = buildCommentBody();
    if (!commentBody) return;
    setFinalComment(commentBody);
    setReviewApproved(false);
    setPushState({ loading: false, error: null, data: null });
    setReviewOpen(true);
  }

  async function pushComment() {
    if (!scope || !targetWorkItemId || !analysis.data || !selectedFindingList.length || !reviewApproved || !finalComment.trim()) return;
    setPushState({ loading: true, error: null, data: null });
    try {
      await postJson("/api/requirement-analysis/comment", {
        scope,
        targetWorkItemId,
        selectedFindingIds: selectedFindingList.map((finding) => finding.id),
        commentBody: finalComment,
      });
      setPushState({ loading: false, error: null, data: { success: true } });
      window.alert("Approved comment pushed to Azure DevOps.");
    } catch (error) {
      setPushState({ loading: false, error: error instanceof Error ? error.message : "Azure DevOps comment push failed.", data: null });
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader title="Target Requirement" description="Enter a real Azure DevOps work item ID. Project context is selected automatically for this run." />
        <div className="grid gap-4 p-4 lg:grid-cols-[240px_auto]">
          <TextInput value={targetWorkItemId} onChange={(event) => setTargetWorkItemId(event.target.value)} placeholder="Work item ID, e.g. 1234" />
          <Button onClick={runAnalysis} disabled={!scope || !targetWorkItemId || analysis.loading}>
            <Play className="h-4 w-4" />
            Analyze
          </Button>
        </div>
      </Card>

      {analysis.error ? <ErrorBlock message={analysis.error} /> : null}
      {pushState.error ? <ErrorBlock message={pushState.error} /> : null}
      {analysis.data ? (
        <Card>
          <CardHeader
            title="Requirement Analysis Findings"
            action={
              <Button onClick={openReview} disabled={!selectedFindingList.length}>
                <Send className="h-4 w-4" />
                Review Comment
              </Button>
            }
          />
          <div className="grid gap-3 border-b p-4 md:grid-cols-4">
            <Metric label="quality" value={analysis.data.summary.overallQuality} />
            <Metric label="clarity" value={analysis.data.summary.clarityScore} />
            <Metric label="completeness" value={analysis.data.summary.completenessScore} />
            <Metric label="testability" value={analysis.data.summary.testabilityScore} />
          </div>
          <div className="divide-y">
            {analysis.data.findings.map((finding) => (
              <div key={finding.id} className="grid gap-4 p-4 xl:grid-cols-[32px_120px_1fr_1.2fr]">
                <input
                  type="checkbox"
                  checked={Boolean(selectedFindings[finding.id])}
                  onChange={(event) => setSelectedFindings((current) => ({ ...current, [finding.id]: event.target.checked }))}
                  className="mt-2 h-4 w-4"
                  aria-label={`Select ${finding.id}`}
                />
                <div>
                  <Badge tone={severityTone(finding.severity)}>{finding.severity}</Badge>
                  <div className="mt-2 text-xs text-muted-foreground">{finding.type}</div>
                </div>
                <div>
                  <div className="font-medium">{finding.title}</div>
                  <p className="mt-2 text-sm text-muted-foreground">{finding.description}</p>
                  <p className="mt-2 text-xs text-muted-foreground">Risk: {finding.riskLevel} - {finding.riskJustification}</p>
                </div>
                <TextArea
                  value={snippets[finding.id] ?? ""}
                  onChange={(event) => setSnippets((current) => ({ ...current, [finding.id]: event.target.value }))}
                />
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {reviewOpen ? (
        <Card>
          <CardHeader
            title="Final Comment Review"
            description="Edit and approve the exact comment before it is pushed to Azure DevOps."
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(finalComment);
                }}
              >
                <Copy className="h-4 w-4" />
                Copy
              </Button>
            }
          />
          <div className="space-y-4 p-4">
            <TextArea
              value={finalComment}
              onChange={(event) => {
                setFinalComment(event.target.value);
                setReviewApproved(false);
              }}
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
              <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                Approved comment pushed to Azure DevOps.
              </div>
            ) : null}
            <div className="flex justify-end">
              <Button onClick={pushComment} disabled={!selectedFindingList.length || !reviewApproved || !finalComment.trim() || pushState.loading}>
                <Send className="h-4 w-4" />
                {pushState.loading ? "Pushing..." : "Push Approved Comment"}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

export function TestCaseGenerationClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [state, setState] = useState<ApiState<{ testCases: GeneratedTestCase[]; summary: TestCaseSummary; contextUsed: string[]; resolvedContextUsed?: unknown[] }>>({ loading: false, error: null, data: null });
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);

  async function generate() {
    if (!scope || !targetWorkItemId) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ testCases: GeneratedTestCase[]; summary: TestCaseSummary; contextUsed: string[]; resolvedContextUsed?: unknown[] }>("/api/test-cases/generate", {
        scope,
        targetWorkItemId,
        options: { depth: "balanced" },
      });
      setState({ loading: false, error: null, data });
      setTestCases(data.testCases);
      window.localStorage.setItem("itestflow.generatedTestCases", JSON.stringify({ targetWorkItemId, testCases: data.testCases }));
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Test case generation failed.", data: null });
    }
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader title="Generate Test Cases from Azure DevOps Requirement" description="Project context is selected automatically for this run." />
        <div className="grid gap-4 p-4 lg:grid-cols-[240px_auto]">
          <TextInput value={targetWorkItemId} onChange={(event) => setTargetWorkItemId(event.target.value)} placeholder="Work item ID" />
          <Button onClick={generate} disabled={!scope || !targetWorkItemId || state.loading}>
            <Play className="h-4 w-4" />
            {state.loading ? "Generating..." : "Generate"}
          </Button>
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
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
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
