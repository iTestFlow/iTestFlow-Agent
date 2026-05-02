"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, Play, RefreshCw, Send, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardHeader, SelectInput, TextArea, TextInput } from "@/shared/components/ui";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type WorkItem = {
  id: string;
  workItemType: string;
  title: string;
  state?: string;
  assignedTo?: string;
  priority?: number;
  iterationPath?: string;
  updatedDate?: string;
};

type ContextSuggestion = {
  workItemId: string;
  title: string;
  workItemType: string;
  relationshipType?: string;
  relevanceScore: number;
  reason: string;
};

type RequirementFinding = {
  id: string;
  severity: "High" | "Medium" | "Low";
  category: string;
  title: string;
  explanation: string;
  suggestedImprovement: string;
  azureDevOpsCommentSnippet: string;
  scoreImpact: number;
  sourceContextIds: string[];
};

type GeneratedTestCase = {
  id: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps: Array<{ index?: number; action: string; expectedResult: string }>;
  testData?: string;
  expectedResult: string;
  priority: "High" | "Medium" | "Low";
  severity: "High" | "Medium" | "Low";
  testType: string;
  automationSuitability: "High" | "Medium" | "Low";
  tags?: string[];
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
  const json = await response.json();
  if (!response.ok) throw new Error(json.error ?? `Request failed: ${response.status}`);
  return json as T;
}

function severityTone(value: string) {
  if (value === "High") return "red" as const;
  if (value === "Medium") return "amber" as const;
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

export function AzureDevOpsWorkItemsClient() {
  const scope = useActiveProject();
  const [state, setState] = useState<ApiState<{ workItems: WorkItem[]; fetchedCount: number; indexedCount: number }>>({
    loading: false,
    error: null,
    data: null,
  });

  async function sync() {
    if (!scope) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ workItems: WorkItem[]; fetchedCount: number; indexedCount: number }>("/api/azure-devops/sync", {
        scope,
      });
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Azure DevOps sync failed.", data: null });
    }
  }

  return (
    <>
      {projectWarning(scope)}
      <Card>
        <div className="flex flex-col gap-3 border-b p-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold">Live Work Item Sync</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Fetches work items from {scope?.azureProjectName ?? "the selected Azure DevOps project"} using your PAT.
            </p>
          </div>
          <Button onClick={sync} disabled={!scope || state.loading}>
            <RefreshCw className="h-4 w-4" />
            {state.loading ? "Syncing..." : "Sync Now"}
          </Button>
        </div>
        {state.error ? <ErrorBlock message={state.error} /> : null}
        {state.data ? (
          <>
            <div className="grid gap-3 border-b p-4 sm:grid-cols-3">
              <Metric label="Fetched" value={state.data.fetchedCount} />
              <Metric label="Indexed" value={state.data.indexedCount} />
              <Metric label="Project" value={scope?.azureProjectName ?? "-"} />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-sm">
                <thead className="bg-[#edf2f7] text-left text-sm text-slate-500">
                  <tr>
                    <th className="px-4 py-3">ID</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Title</th>
                    <th className="px-4 py-3">State</th>
                    <th className="px-4 py-3">Assigned To</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3">Iteration</th>
                    <th className="px-4 py-3">Updated</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {state.data.workItems.map((item) => (
                    <tr key={item.id} className="hover:bg-muted/30">
                      <td className="px-4 py-3 font-mono text-xs text-blue-600">{item.id}</td>
                      <td className="px-4 py-3">{item.workItemType}</td>
                      <td className="px-4 py-3 font-medium">{item.title}</td>
                      <td className="px-4 py-3">{item.state ?? "-"}</td>
                      <td className="px-4 py-3">{item.assignedTo ?? "-"}</td>
                      <td className="px-4 py-3">{item.priority ?? "-"}</td>
                      <td className="px-4 py-3">{item.iterationPath ?? "-"}</td>
                      <td className="px-4 py-3">{item.updatedDate ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <EmptyBlock message="No work items loaded yet. Select a project and run Sync Now." />
        )}
      </Card>
    </>
  );
}

export function RequirementAnalysisClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [contextIds, setContextIds] = useState("");
  const [suggestions, setSuggestions] = useState<ApiState<{ suggestions: ContextSuggestion[] }>>({ loading: false, error: null, data: null });
  const [analysis, setAnalysis] = useState<ApiState<{ findings: RequirementFinding[]; scores: Record<string, number>; executiveSummary: string }>>({
    loading: false,
    error: null,
    data: null,
  });
  const [selectedFindings, setSelectedFindings] = useState<Record<string, boolean>>({});
  const [snippets, setSnippets] = useState<Record<string, string>>({});
  const selectedContextIds = useMemo(() => contextIds.split(",").map((item) => item.trim()).filter(Boolean), [contextIds]);

  async function suggest() {
    if (!scope || !targetWorkItemId) return;
    setSuggestions({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ suggestions: ContextSuggestion[] }>("/api/context/suggestions", { scope, targetWorkItemId });
      setSuggestions({ loading: false, error: null, data });
      setContextIds(data.suggestions.map((item) => item.workItemId).join(", "));
    } catch (error) {
      setSuggestions({ loading: false, error: error instanceof Error ? error.message : "Context suggestion failed.", data: null });
    }
  }

  async function runAnalysis() {
    if (!scope || !targetWorkItemId) return;
    setAnalysis({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ findings: RequirementFinding[]; scores: Record<string, number>; executiveSummary: string }>(
        "/api/requirement-analysis/run",
        { scope, targetWorkItemId, selectedContextIds },
      );
      setAnalysis({ loading: false, error: null, data });
      setSelectedFindings(Object.fromEntries(data.findings.map((finding) => [finding.id, true])));
      setSnippets(Object.fromEntries(data.findings.map((finding) => [finding.id, finding.azureDevOpsCommentSnippet])));
    } catch (error) {
      setAnalysis({ loading: false, error: error instanceof Error ? error.message : "Requirement analysis failed.", data: null });
    }
  }

  async function pushComment() {
    if (!scope || !targetWorkItemId || !analysis.data) return;
    const selected = analysis.data.findings.filter((finding) => selectedFindings[finding.id]);
    const commentBody = [
      `## iTestFlow Requirement Analysis for ${targetWorkItemId}`,
      analysis.data.executiveSummary,
      ...selected.map((finding) => `### [${finding.severity}] ${finding.title}\n${snippets[finding.id] ?? finding.azureDevOpsCommentSnippet}`),
    ].join("\n\n");
    await postJson("/api/requirement-analysis/comment", {
      scope,
      targetWorkItemId,
      selectedFindingIds: selected.map((finding) => finding.id),
      commentBody,
    });
    window.alert("Approved comment pushed to Azure DevOps.");
  }

  return (
    <div className="space-y-6">
      {projectWarning(scope)}
      <Card>
        <CardHeader title="Target Requirement and Context" description="Enter a real Azure DevOps work item ID from the selected project." />
        <div className="grid gap-4 p-4 lg:grid-cols-[240px_1fr_auto_auto]">
          <TextInput value={targetWorkItemId} onChange={(event) => setTargetWorkItemId(event.target.value)} placeholder="Work item ID, e.g. 1234" />
          <TextInput value={contextIds} onChange={(event) => setContextIds(event.target.value)} placeholder="Selected context work item IDs, comma separated" />
          <Button variant="secondary" onClick={suggest} disabled={!scope || !targetWorkItemId || suggestions.loading}>
            <Play className="h-4 w-4" />
            Suggest Context
          </Button>
          <Button onClick={runAnalysis} disabled={!scope || !targetWorkItemId || analysis.loading}>
            <Play className="h-4 w-4" />
            Analyze
          </Button>
        </div>
      </Card>

      {suggestions.error ? <ErrorBlock message={suggestions.error} /> : null}
      {suggestions.data?.suggestions.length ? (
        <Card>
          <CardHeader title="Suggested Context Stories" />
          <div className="divide-y">
            {suggestions.data.suggestions.map((item) => (
              <div key={item.workItemId} className="grid gap-3 p-4 md:grid-cols-[120px_1fr_110px_1fr]">
                <span className="font-mono text-xs text-blue-600">{item.workItemId}</span>
                <span className="font-medium">{item.title}</span>
                <span>{Math.round(item.relevanceScore * 100)}%</span>
                <span className="text-sm text-muted-foreground">{item.reason}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {analysis.error ? <ErrorBlock message={analysis.error} /> : null}
      {analysis.data ? (
        <Card>
          <CardHeader title="Requirement Analysis Findings" action={<Button onClick={pushComment}><Send className="h-4 w-4" />Push Comment</Button>} />
          <div className="grid gap-3 border-b p-4 md:grid-cols-4">
            {Object.entries(analysis.data.scores).slice(0, 4).map(([key, value]) => (
              <Metric key={key} label={key} value={value} />
            ))}
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
                  <div className="mt-2 text-xs text-muted-foreground">{finding.category}</div>
                </div>
                <div>
                  <div className="font-medium">{finding.title}</div>
                  <p className="mt-2 text-sm text-muted-foreground">{finding.explanation}</p>
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
    </div>
  );
}

export function TestCaseGenerationClient() {
  const scope = useActiveProject();
  const [targetWorkItemId, setTargetWorkItemId] = useState("");
  const [contextIds, setContextIds] = useState("");
  const [state, setState] = useState<ApiState<{ testCases: GeneratedTestCase[]; summary: string }>>({ loading: false, error: null, data: null });
  const [testCases, setTestCases] = useState<GeneratedTestCase[]>([]);
  const selectedContextIds = useMemo(() => contextIds.split(",").map((item) => item.trim()).filter(Boolean), [contextIds]);

  async function generate() {
    if (!scope || !targetWorkItemId) return;
    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ testCases: GeneratedTestCase[]; summary: string }>("/api/test-cases/generate", {
        scope,
        targetWorkItemId,
        selectedContextIds,
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
        <CardHeader title="Generate Test Cases from Azure DevOps Requirement" />
        <div className="grid gap-4 p-4 lg:grid-cols-[240px_1fr_auto]">
          <TextInput value={targetWorkItemId} onChange={(event) => setTargetWorkItemId(event.target.value)} placeholder="Work item ID" />
          <TextInput value={contextIds} onChange={(event) => setContextIds(event.target.value)} placeholder="Selected context IDs, comma separated" />
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

  useEffect(() => {
    fetch("/api/audit-logs", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "Audit log fetch failed.");
        setState({ loading: false, error: null, data: json });
      })
      .catch((error: unknown) => setState({ loading: false, error: error instanceof Error ? error.message : "Audit log fetch failed.", data: null }));
  }, []);

  if (state.error) return <ErrorBlock message={state.error} />;
  if (state.loading) return <EmptyBlock message="Loading live audit logs..." />;

  return (
    <Card>
      <CardHeader title="Live Audit Log Entries" />
      <pre className="max-h-[620px] overflow-auto p-4 text-xs text-muted-foreground">{JSON.stringify(state.data?.logs ?? [], null, 2)}</pre>
    </Card>
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
                <option>High</option>
                <option>Medium</option>
                <option>Low</option>
              </SelectInput>
              <Badge tone="cyan">{testCase.testType}</Badge>
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
                    steps: [...testCase.steps, { index: testCase.steps.length + 1, action: "", expectedResult: "" }],
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
    <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
      <div className="flex items-center gap-2 font-medium">
        <AlertTriangle className="h-4 w-4" />
        Action failed
      </div>
      <p className="mt-2 text-red-100/90">{message}</p>
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
