"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Loader2, Sparkles, SquareTerminal } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/qa/stat-card";
import { GenerationModeToggle } from "@/components/workflow/generation-mode-toggle";
import { ManualLLMPanel } from "@/components/workflow/manual-llm-panel";
import { WorkItemSummaryCard } from "@/components/workflow/work-item-summary-card";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";

type WorkflowMode = "auto" | "manual";
type TesterSeniority = "junior" | "mid" | "senior";
type ExecutionType = "first_execution" | "regression_reexecution" | "uat_support";

type EffortOptions = {
  testerSeniority: TesterSeniority;
  executionType: ExecutionType;
  includeDataPreparation: boolean;
  includeEnvironmentSetup: boolean;
  includeEvidenceAndDefectLogging: boolean;
  includeRetestingBuffer: boolean;
};

type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

type StorySummary = {
  id: string;
  title: string;
  workItemType: string;
  state: string;
  areaPath?: string;
  iterationPath?: string;
};

type WorkItem = StorySummary & {
  description?: string;
  acceptanceCriteria?: string;
  tags?: string[];
};

type PreviewSummary = {
  linkedTestCaseCount: number;
  totalSteps: number;
  testCasesWithMissingSteps: number;
  hasProjectContext: boolean;
  workItemTypeWarning?: string;
};

type PreviewTestCase = {
  id: string;
  title: string;
  stepsCount: number;
  hasMissingSteps: boolean;
};

type EffortPreview = {
  story: StorySummary;
  summary: PreviewSummary;
  testCases: PreviewTestCase[];
  selectedContextIds?: string[];
  resolvedContextUsed?: unknown[];
  retrievalTopK?: number | null;
  options?: EffortOptions;
};

type EffortEstimate = {
  story: StorySummary;
  executionProfile: {
    testerSeniority: TesterSeniority;
    executionType: ExecutionType;
    includedFactors: {
      dataPreparation: boolean;
      environmentSetup: boolean;
      evidenceAndDefectLogging: boolean;
      retestingBuffer: boolean;
    };
  };
  statistics: {
    testCaseCount: number;
    totalSteps: number;
    averageStepsPerTestCase: number;
    simpleTestCases: number;
    mediumTestCases: number;
    complexTestCases: number;
    testCasesWithMissingSteps: number;
    integrationPointsCount: number;
    dataPreparationComplexity: "Low" | "Medium" | "High";
    environmentSetupComplexity: "Low" | "Medium" | "High";
    executionComplexity: "Low" | "Medium" | "High";
  };
  estimate: {
    minimumHours: number;
    mostLikelyHours: number;
    maximumHours: number;
    recommendedPlanningHours: number;
    confidence: "Low" | "Medium" | "High";
    confidenceReason: string;
  };
  breakdown: Array<{ area: string; estimatedHours: number; reason: string }>;
  testCaseEstimates: Array<{
    testCaseId: string;
    title: string;
    stepsCount: number;
    complexity: "Simple" | "Medium" | "Complex";
    executionMinutes: number;
    dataPreparationMinutes: number;
    environmentSetupMinutes: number;
    integrationValidationMinutes: number;
    evidenceAndDefectLoggingMinutes: number;
    retestingBufferMinutes: number;
    totalEstimatedMinutes: number;
    reason: string;
  }>;
  assumptions: string[];
  risksThatMayIncreaseTime: string[];
  recommendations: string[];
};

type GenerateResponse = EffortPreview & {
  provider: string;
  model: string;
  rawOutput: string;
  estimate: EffortEstimate;
};

type ExternalPromptDraft = EffortPreview & {
  prompt: string;
  promptVersion: string;
  schemaName: string;
  promptName: string;
};

const defaultOptions: EffortOptions = {
  testerSeniority: "mid",
  executionType: "first_execution",
  includeDataPreparation: true,
  includeEnvironmentSetup: true,
  includeEvidenceAndDefectLogging: true,
  includeRetestingBuffer: true,
};

const testerSeniorityDescription: Record<TesterSeniority, string> = {
  junior: "Adds time for understanding, data setup, investigation, evidence capture, and defect reporting support.",
  mid: "Baseline estimate for an experienced tester who can execute common flows independently.",
  senior: "May execute faster, but can spend extra time validating complex integration and hidden risk areas.",
};

const executionTypeDescription: Record<ExecutionType, string> = {
  first_execution: "Includes story understanding, first-time setup, unclear behavior investigation, and a higher defect likelihood.",
  regression_reexecution: "Usually faster because flows and data are known, while still checking integration and environment readiness.",
  uat_support: "Includes business validation, stakeholder support, evidence preparation, and communication overhead.",
};

export function TestExecutionEffortClient() {
  const scope = useActiveProject();
  const [storyId, setStoryId] = useState("");
  const [storyLookup, setStoryLookup] = useState<ApiState<WorkItem>>({ loading: false, error: null, data: null });
  const [mode, setMode] = useState<WorkflowMode>("auto");
  const [options, setOptions] = useState<EffortOptions>(defaultOptions);
  const [preview, setPreview] = useState<EffortPreview | null>(null);
  const [estimateResult, setEstimateResult] = useState<GenerateResponse | null>(null);
  const [externalDraft, setExternalDraft] = useState<ExternalPromptDraft | null>(null);
  const [externalResponse, setExternalResponse] = useState("");
  const [loadingAction, setLoadingAction] = useState<"generate" | "prompt" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const requestPayload = useMemo(() => ({
    scope,
    storyId: storyId.trim(),
    ...options,
  }), [options, scope, storyId]);

  function clearOutputs() {
    setPreview(null);
    setEstimateResult(null);
    setExternalDraft(null);
    setExternalResponse("");
    setError(null);
  }

  const loadStory = useCallback(async () => {
    if (!scope || !storyId.trim()) {
      setStoryLookup({ loading: false, error: null, data: null });
      return;
    }
    if (!/^\d+$/.test(storyId.trim())) {
      setStoryLookup({ loading: false, error: "Enter a valid numeric User Story ID.", data: null });
      return;
    }
    setStoryLookup({ loading: true, error: null, data: null });
    try {
      const data = await postJson<{ workItem: WorkItem }>("/api/azure-devops/work-item-details", {
        scope,
        workItemId: storyId.trim(),
      });
      setStoryLookup({ loading: false, error: null, data: data.workItem });
    } catch (lookupError) {
      setStoryLookup({
        loading: false,
        error: lookupError instanceof Error ? lookupError.message : "Story lookup failed.",
        data: null,
      });
    }
  }, [scope, storyId]);

  useEffect(() => {
    if (!scope || !storyId.trim()) {
      setStoryLookup({ loading: false, error: null, data: null });
      return;
    }
    const timeoutId = window.setTimeout(() => {
      void loadStory();
    }, 700);
    return () => window.clearTimeout(timeoutId);
  }, [loadStory, scope, storyId]);

  function updateOption<TKey extends keyof EffortOptions>(key: TKey, value: EffortOptions[TKey]) {
    setOptions((current) => ({ ...current, [key]: value }));
    clearOutputs();
  }

  async function generateEstimate() {
    if (!canSubmit()) return;
    await runRequest("generate", "/api/test-execution-effort/generate", (data: GenerateResponse) => {
      setPreview(data);
      setEstimateResult(data);
      setExternalDraft(null);
      setExternalResponse("");
    });
  }

  async function prepareExternalPrompt() {
    if (!canSubmit()) return;
    await runRequest("prompt", "/api/test-execution-effort/external-prompt", (data: ExternalPromptDraft) => {
      setPreview(data);
      setEstimateResult(null);
      setExternalDraft(data);
      setExternalResponse("");
    });
  }

  async function submitExternalResponse() {
    if (!scope || !externalDraft || !externalResponse.trim()) return;
    setLoadingAction("submit");
    setError(null);
    try {
      const data = await postJson<GenerateResponse>("/api/test-execution-effort/manual/submit", {
        ...requestPayload,
        rawOutput: externalResponse,
        selectedContextIds: externalDraft.selectedContextIds ?? [],
        resolvedContextUsed: externalDraft.resolvedContextUsed ?? [],
        retrievalTopK: externalDraft.retrievalTopK,
      });
      setPreview(data);
      setEstimateResult(data);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "External LLM response validation failed.");
    } finally {
      setLoadingAction(null);
    }
  }

  function canSubmit() {
    if (!scope) {
      setError("Please select an Azure DevOps project before estimating execution effort.");
      return false;
    }
    if (!storyId.trim()) {
      setError("Enter a User Story ID.");
      return false;
    }
    if (!/^\d+$/.test(storyId.trim())) {
      setError("Enter a valid numeric User Story ID.");
      return false;
    }
    setError(null);
    return true;
  }

  async function runRequest<TData>(action: "generate" | "prompt", url: string, onSuccess: (data: TData) => void) {
    setLoadingAction(action);
    setError(null);
    try {
      const data = await postJson<TData>(url, requestPayload);
      onSuccess(data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Test Execution Effort request failed.");
    } finally {
      setLoadingAction(null);
    }
  }

  const busy = Boolean(loadingAction);
  const actionDisabled = busy || !scope || !storyId.trim();

  return (
    <div className="space-y-5">
      {!scope ? (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>No active project selected</AlertTitle>
          <AlertDescription>Select an Azure DevOps project from the top bar before running this workflow.</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-0.5">
            <CardTitle className="text-base">Estimate Inputs</CardTitle>
            <CardDescription>Load the story, linked Azure DevOps test cases, and project context before estimating manual execution effort.</CardDescription>
          </div>
          <GenerationModeToggle mode={mode} onChange={setMode} />
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid gap-4 lg:grid-cols-[minmax(260px,360px)_1fr]">
            <Field label="User Story ID">
              <Input
                value={storyId}
                inputMode="numeric"
                maxLength={10}
                placeholder="e.g. 123456"
                onChange={(event) => {
                  setStoryId(event.target.value);
                  setStoryLookup({ loading: false, error: null, data: null });
                  clearOutputs();
                }}
              />
            </Field>
            <WorkItemSummaryCard
              story={storyLookup.data}
              loading={storyLookup.loading}
              error={storyLookup.error}
              valid={storyLookup.data ? isRequirementLikeType(storyLookup.data.workItemType) : true}
              invalidNote="This work item is not a typical story/requirement type."
              emptyText="No user story loaded."
              loadingText="Loading user story..."
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Tester Seniority">
              <Select value={options.testerSeniority} onValueChange={(value) => updateOption("testerSeniority", value as TesterSeniority)}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="junior">Junior QA</SelectItem>
                  <SelectItem value="mid">Mid-level QA</SelectItem>
                  <SelectItem value="senior">Senior QA</SelectItem>
                </SelectContent>
              </Select>
              <OptionDescription>{testerSeniorityDescription[options.testerSeniority]}</OptionDescription>
            </Field>
            <Field label="Execution Type">
              <Select value={options.executionType} onValueChange={(value) => updateOption("executionType", value as ExecutionType)}>
                <SelectTrigger className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="first_execution">First Execution</SelectItem>
                  <SelectItem value="regression_reexecution">Regression Re-execution</SelectItem>
                  <SelectItem value="uat_support">UAT Support</SelectItem>
                </SelectContent>
              </Select>
              <OptionDescription>{executionTypeDescription[options.executionType]}</OptionDescription>
            </Field>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <OptionToggle
              checked={options.includeDataPreparation}
              label="Include test data preparation time"
              onChange={(checked) => updateOption("includeDataPreparation", checked)}
            />
            <OptionToggle
              checked={options.includeEnvironmentSetup}
              label="Include environment/setup time"
              onChange={(checked) => updateOption("includeEnvironmentSetup", checked)}
            />
            <OptionToggle
              checked={options.includeEvidenceAndDefectLogging}
              label="Include evidence capture and defect logging buffer"
              onChange={(checked) => updateOption("includeEvidenceAndDefectLogging", checked)}
            />
            <OptionToggle
              checked={options.includeRetestingBuffer}
              label="Include retesting buffer"
              onChange={(checked) => updateOption("includeRetestingBuffer", checked)}
            />
          </div>

          <div className="flex justify-end">
            <div className="flex flex-col gap-2 sm:flex-row">
              {mode === "auto" ? (
                <Button onClick={generateEstimate} disabled={actionDisabled}>
                  {loadingAction === "generate" ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  {loadingAction === "generate" ? "Generating..." : "Generate Estimate"}
                </Button>
              ) : (
                <Button onClick={prepareExternalPrompt} disabled={actionDisabled}>
                  {loadingAction === "prompt" ? <Loader2 className="size-4 animate-spin" /> : <SquareTerminal className="size-4" />}
                  {loadingAction === "prompt" ? "Preparing..." : "Prepare External LLM Prompt"}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {preview ? <StorySummaryPanel preview={preview} /> : null}

      {externalDraft ? (
        <ManualLLMPanel
          prompt={externalDraft.prompt}
          promptVersion={externalDraft.promptVersion}
          schemaName={externalDraft.schemaName}
          response={externalResponse}
          onResponseChange={setExternalResponse}
          onSubmit={submitExternalResponse}
          submitting={loadingAction === "submit"}
        />
      ) : null}

      {estimateResult ? <EstimateResultPanel result={estimateResult.estimate} /> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function OptionDescription({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-5 text-muted-foreground">{children}</p>;
}

function OptionToggle({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex min-h-12 items-start gap-3 rounded-lg border bg-background p-3 text-sm">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} className="mt-0.5" />
      <span className="leading-5 text-foreground">{label}</span>
    </label>
  );
}

function StorySummaryPanel({ preview }: { preview: EffortPreview }) {
  const hasMissingSteps = preview.summary.testCasesWithMissingSteps > 0;
  const linkedTestCaseDetail = hasMissingSteps
    ? `${preview.summary.totalSteps} total steps, ${preview.summary.testCasesWithMissingSteps} missing steps`
    : `${preview.summary.totalSteps} total steps`;

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Story and Test Case Summary</CardTitle>
        <CardDescription>Fetched from the selected Azure DevOps project.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {preview.summary.workItemTypeWarning ? (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertTitle>Work item type warning</AlertTitle>
            <AlertDescription>{preview.summary.workItemTypeWarning}</AlertDescription>
          </Alert>
        ) : null}
        {hasMissingSteps ? (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertTitle>Missing test steps</AlertTitle>
            <AlertDescription>Some linked test cases have no manual steps. The estimate may be less accurate.</AlertDescription>
          </Alert>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Linked Test Cases" value={String(preview.summary.linkedTestCaseCount)} detail={linkedTestCaseDetail} />
        </div>
      </CardContent>
    </Card>
  );
}

function EstimateResultPanel({ result }: { result: EffortEstimate }) {
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="border-b">
          <CardTitle>Execution Effort Estimate</CardTitle>
          <CardDescription>{result.estimate.confidenceReason}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Minimum" value={formatHours(result.estimate.minimumHours)} detail="Optimistic lower bound" />
            <StatCard label="Most Likely" value={formatHours(result.estimate.mostLikelyHours)} detail="Expected execution effort" />
            <StatCard label="Maximum" value={formatHours(result.estimate.maximumHours)} detail="Upper bound if risks appear" />
            <StatCard label="Planning Estimate" value={formatHours(result.estimate.recommendedPlanningHours)} detail="Recommended sprint planning value" tone="primary" />
            <StatCard label="Confidence" value={result.estimate.confidence} detail="Based on available test details" />
          </div>
        </CardContent>
      </Card>

      <StatisticsPanel statistics={result.statistics} />
      <BreakdownTable rows={result.breakdown} />
      <TestCaseEstimateTable rows={result.testCaseEstimates} />
      <PlanningNotesPanel
        assumptions={result.assumptions}
        risks={result.risksThatMayIncreaseTime}
        recommendations={result.recommendations}
      />
    </div>
  );
}

function StatisticsPanel({ statistics }: { statistics: EffortEstimate["statistics"] }) {
  const rows = [
    ["Test case count", statistics.testCaseCount],
    ["Total steps", statistics.totalSteps],
    ["Average steps per test case", statistics.averageStepsPerTestCase],
    ["Simple test cases", statistics.simpleTestCases],
    ["Medium test cases", statistics.mediumTestCases],
    ["Complex test cases", statistics.complexTestCases],
    ["Test cases with missing steps", statistics.testCasesWithMissingSteps],
    ["Integration points", statistics.integrationPointsCount],
    ["Data preparation complexity", statistics.dataPreparationComplexity],
    ["Environment setup complexity", statistics.environmentSetupComplexity],
    ["Execution complexity", statistics.executionComplexity],
  ];

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Statistics</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map(([label, value]) => (
            <StatCard key={String(label)} label={label} value={String(value)} size="sm" />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BreakdownTable({ rows }: { rows: EffortEstimate["breakdown"] }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Breakdown</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Area</TableHead>
                <TableHead>Estimated hours</TableHead>
                <TableHead className="min-w-[360px]">Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.area}-${row.estimatedHours}`}>
                  <TableCell className="font-medium">{row.area}</TableCell>
                  <TableCell>{formatHours(row.estimatedHours)}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{row.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function TestCaseEstimateTable({ rows }: { rows: EffortEstimate["testCaseEstimates"] }) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Test Case Estimates</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Test Case ID</TableHead>
                <TableHead className="min-w-[260px]">Title</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Complexity</TableHead>
                <TableHead>Execution</TableHead>
                <TableHead>Data prep</TableHead>
                <TableHead>Setup</TableHead>
                <TableHead>Integration</TableHead>
                <TableHead>Evidence/defect</TableHead>
                <TableHead>Retesting</TableHead>
                <TableHead>Total</TableHead>
                <TableHead className="min-w-[320px]">Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.testCaseId}>
                  <TableCell className="font-mono text-xs text-primary">{row.testCaseId}</TableCell>
                  <TableCell className="whitespace-normal font-medium">{row.title}</TableCell>
                  <TableCell>{row.stepsCount}</TableCell>
                  <TableCell><Badge variant="outline">{row.complexity}</Badge></TableCell>
                  <TableCell>{formatMinutes(row.executionMinutes)}</TableCell>
                  <TableCell>{formatMinutes(row.dataPreparationMinutes)}</TableCell>
                  <TableCell>{formatMinutes(row.environmentSetupMinutes)}</TableCell>
                  <TableCell>{formatMinutes(row.integrationValidationMinutes)}</TableCell>
                  <TableCell>{formatMinutes(row.evidenceAndDefectLoggingMinutes)}</TableCell>
                  <TableCell>{formatMinutes(row.retestingBufferMinutes)}</TableCell>
                  <TableCell className="font-semibold">{formatMinutes(row.totalEstimatedMinutes)}</TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{row.reason}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function PlanningNotesPanel({
  assumptions,
  risks,
  recommendations,
}: {
  assumptions: string[];
  risks: string[];
  recommendations: string[];
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Planning Notes</CardTitle>
        <CardDescription>Assumptions, risks, and recommendations used to interpret the estimate.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 lg:grid-cols-3">
          <InsightColumn
            title="Assumptions"
            items={assumptions}
            icon={<CheckCircle2 className="size-4 text-success" />}
            tone="emerald"
          />
          <InsightColumn
            title="Risks That May Increase Time"
            items={risks}
            icon={<AlertCircle className="size-4 text-warning" />}
            tone="amber"
          />
          <InsightColumn
            title="Recommendations"
            items={recommendations}
            icon={<Sparkles className="size-4 text-primary" />}
            tone="primary"
          />
        </div>
      </CardContent>
    </Card>
  );
}

function InsightColumn({
  title,
  items,
  icon,
  tone,
}: {
  title: string;
  items: string[];
  icon: ReactNode;
  tone: "emerald" | "amber" | "primary";
}) {
  const toneClass = {
    emerald: "border-success/30 bg-success/10",
    amber: "border-warning/40 bg-warning/15",
    primary: "border-primary/20 bg-primary/5",
  }[tone];

  return (
    <section className={cn("rounded-lg border p-4", toneClass)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {icon}
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        </div>
        <Badge variant="outline">{items.length}</Badge>
      </div>
      {items.length ? (
        <ul className="mt-4 space-y-2">
          {items.map((item, index) => (
            <li key={`${title}-${index}`} className="rounded-md border bg-background/80 p-3 text-sm leading-6 text-foreground">
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-md border bg-background/80 p-3 text-sm text-muted-foreground">No items returned.</p>
      )}
    </section>
  );
}

function useActiveProject() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);

  useEffect(() => {
    setScope(readActiveProject());
    function onProjectChanged(event: Event) {
      const customEvent = event as CustomEvent<ActiveProjectScope>;
      setScope(customEvent.detail ?? readActiveProject());
    }
    window.addEventListener("itestflow:active-project-changed", onProjectChanged);
    return () => window.removeEventListener("itestflow:active-project-changed", onProjectChanged);
  }, []);

  return scope;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Request failed.");
  }
  return data as T;
}

function formatHours(value: number) {
  return `${formatNumber(value)}h`;
}

function formatMinutes(value: number) {
  return `${formatNumber(value)}m`;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function isRequirementLikeType(workItemType: string) {
  return ["user story", "product backlog item", "requirement", "feature", "bug"].includes(workItemType.trim().toLowerCase());
}
