"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, Copy, Loader2, Plus, Send, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { toneClass, type Tone } from "@/components/qa/tone";
import { cn } from "@/lib/utils";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import type {
  ApiState,
  GeneratedTestCase,
  PublishRunResult,
  SuggestedAdditionsPublishResult,
  TestPlan,
  TestSuite,
} from "@/components/workflow/test-intelligence-types";

/* --------------------------------------------------------------------------
 * Shared infrastructure for the AI test-intelligence workflows. Extracted from
 * the former live-workflows.tsx monolith. Pure presentational + client utils;
 * each route owns its own fetch/state. Migrated fully onto @/components/ui.
 * ------------------------------------------------------------------------ */

const COPY_FEEDBACK_MS = 3000;

export function useActiveProject() {
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

export async function postJson<T>(url: string, body: unknown): Promise<T> {
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

export function scrollToNextStep(ref: React.RefObject<HTMLElement | null>) {
  window.setTimeout(() => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 120);
}

export function extractAzureId(value: string, kind: "plan" | "suite") {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const queryPattern = kind === "plan" ? /[?&]planId=(\d+)/i : /[?&]suiteId=(\d+)/i;
  const pathPattern = kind === "plan" ? /\/plans\/(\d+)(?:\/|$|\?)/i : /\/suites\/(\d+)(?:\/|$|\?)/i;
  return trimmed.match(queryPattern)?.[1] ?? trimmed.match(pathPattern)?.[1] ?? "";
}

export function normalizeTestCasePriority(value: unknown): GeneratedTestCase["priority"] {
  if (value === 1 || value === "1" || value === "critical") return 1;
  if (value === 2 || value === "2" || value === "high") return 2;
  if (value === 3 || value === "3" || value === "medium") return 3;
  if (value === 4 || value === "4" || value === "low") return 4;
  return 2;
}

export async function copyTextWithFeedback(text: string, setCopied: (copied: boolean) => void) {
  try {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  } catch (error) {
    console.error("Clipboard copy failed", error);
  }
}

export function formatEnumLabel(value: string) {
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

export function formatPercentage(value: number) {
  return `${Math.round(value)}%`;
}

export function severityTone(value: string): Tone {
  if (value === "critical" || value === "high" || value === "High") return "error";
  if (value === "medium" || value === "Medium") return "warning";
  return "success";
}

export function qualityTone(value: string): Tone {
  if (value === "excellent" || value === "good") return "success";
  if (value === "fair") return "warning";
  return "error";
}

export function scoreTone(value: number): Tone {
  if (value >= 80) return "success";
  if (value >= 60) return "warning";
  return "error";
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

/* ----- Shared presentational primitives ----- */

export function ToneBadge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-full border", toneClass[tone], className)}>
      {children}
    </Badge>
  );
}

/**
 * Section card built on the active Card primitive (gap/py neutralized so the
 * existing body layouts are preserved). Replaces the legacy `Card` + `CardHeader`.
 */
export function SectionCard({
  title,
  description,
  action,
  className,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", className)}>
      {title || action || description ? (
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-0.5">
            {title ? <CardTitle className="text-base">{title}</CardTitle> : null}
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <Callout tone="error" title="Action failed">
      <span className="break-words">{message}</span>
    </Callout>
  );
}

export function EmptyBlock({ message }: { message: string }) {
  return (
    <Callout tone="info" icon={CheckCircle2}>
      {message}
    </Callout>
  );
}

export function projectWarning(scope: ActiveProjectScope | null) {
  if (scope) return null;
  return <Callout tone="warning">Please select an Azure DevOps project before running this action.</Callout>;
}

export function Metric({ label, value }: { label: string; value: string | number }) {
  const isNumeric = typeof value === "number";
  const displayValue = isNumeric ? formatPercentage(value) : formatEnumLabel(value);
  const tone = isNumeric ? scoreTone(value) : qualityTone(value);

  return (
    <div className={cn("rounded-md border p-4", toneClass[tone])}>
      <div className="text-base font-semibold text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold">{displayValue}</div>
    </div>
  );
}

type GeneratedCaseSummaryRow = {
  label: string;
  value: number;
  tone: "red" | "amber" | "blue" | "cyan" | "slate";
};

function GeneratedCaseTotalCard({ total }: { total: number }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-base font-semibold text-muted-foreground">Total</div>
      <div className="mt-2 text-4xl font-bold text-foreground">{total}</div>
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
  footer?: ReactNode;
}) {
  const hasValues = rows.some((row) => row.value > 0);

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-base font-semibold text-muted-foreground">{title}</div>
      {hasValues ? (
        <div className="mt-3 grid gap-2">
          {rows.map((row) => (
            <GeneratedCaseSummaryRowItem key={row.label} row={row} />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-dashed border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      )}
      {footer}
    </div>
  );
}

function GeneratedCaseSummaryRowItem({ row }: { row: GeneratedCaseSummaryRow }) {
  const toneStyles = {
    red: "bg-destructive/10 text-destructive",
    amber: "bg-warning/15 text-warning-foreground",
    blue: "bg-accent text-primary",
    cyan: "bg-info/10 text-info",
    slate: "bg-muted text-foreground",
  }[row.tone];
  const empty = row.value === 0;

  return (
    <div className={`flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm ${empty ? "bg-muted text-muted-foreground" : toneStyles}`}>
      <span className={empty ? "text-muted-foreground" : "font-medium"}>{row.label}</span>
      <span className={empty ? "text-xs text-muted-foreground" : "text-base font-bold"}>{empty ? "None" : row.value}</span>
    </div>
  );
}

const generatedCaseSelectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function EditableGeneratedCases({
  testCases,
  setTestCases,
  title = "Generated Test Cases",
  caseActions = true,
  allowDelete = caseActions,
  allowAdd = caseActions,
}: {
  testCases: GeneratedTestCase[];
  setTestCases: (testCases: GeneratedTestCase[]) => void;
  title?: string;
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
    <SectionCard title={title} description="Edit titles and steps inline before publishing.">
      <div className="grid gap-3 border-b border-border bg-muted p-4 lg:grid-cols-[180px_minmax(260px,1fr)_minmax(260px,1fr)]">
        <GeneratedCaseTotalCard total={testCaseStats.total} />
        <GeneratedCaseSummaryCard title="Priority Breakdown" rows={priorityBreakdown} />
        <GeneratedCaseSummaryCard title="Type" rows={scopeBreakdown} emptyLabel="No scope values yet" />
      </div>
      <div className="divide-y divide-border">
        {testCases.length ? testCases.map((testCase, index) => (
          <div key={testCase.id} className="space-y-3 p-4">
            <div className="grid gap-3 lg:grid-cols-[120px_1fr_160px_160px_42px]">
              <span className="font-mono text-xs text-primary">{testCase.id}</span>
              <Input value={testCase.title} onChange={(event) => updateCase(index, { ...testCase, title: event.target.value })} />
              <select
                className={generatedCaseSelectClass}
                value={testCase.priority}
                onChange={(event) => updateCase(index, { ...testCase, priority: Number(event.target.value) as GeneratedTestCase["priority"] })}
                aria-label={`Priority for ${testCase.id}`}
              >
                <option value={1}>1 - Highest</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4 - Lowest</option>
              </select>
              <ToneBadge tone="info">{testCase.type}</ToneBadge>
              {allowDelete ? (
                <Button variant="ghost" size="icon" onClick={() => deleteCase(index)} aria-label={`Delete ${testCase.id}`}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
            <div className="rounded-md border border-border">
              {testCase.steps.map((step, stepIndex) => (
                <div key={`${testCase.id}-${stepIndex}`} className="grid gap-2 border-b border-border p-3 last:border-b-0 lg:grid-cols-[40px_1fr_1fr_42px]">
                  <span className="pt-2 font-mono text-xs text-muted-foreground">{stepIndex + 1}</span>
                  <Input
                    value={step.action}
                    onChange={(event) => {
                      const steps = [...testCase.steps];
                      steps[stepIndex] = { ...step, action: event.target.value };
                      updateCase(index, { ...testCase, steps });
                    }}
                  />
                  <Input
                    value={step.expectedResult}
                    onChange={(event) => {
                      const steps = [...testCase.steps];
                      steps[stepIndex] = { ...step, expectedResult: event.target.value };
                      updateCase(index, { ...testCase, steps });
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
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
              <Button variant="secondary" onClick={() => navigator.clipboard.writeText(JSON.stringify(testCase, null, 2))}>
                <Copy className="h-4 w-4" />
                Copy JSON
              </Button>
            </div>
          </div>
        )) : (
          <div className="p-4">
            <div className="rounded-md border border-dashed border-border bg-muted p-5 text-sm text-muted-foreground">
              {allowAdd ? "No test cases in this list. Add a test case to continue." : "No test cases in this list."}
            </div>
          </div>
        )}
      </div>
      {allowAdd ? (
        <div className="flex justify-end border-t border-border px-5 py-4">
          <Button variant="secondary" onClick={addCase}>
            <Plus className="h-4 w-4" />
            Add Test Case
          </Button>
        </div>
      ) : null}
    </SectionCard>
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
  const tone = success ? "text-success" : "text-destructive";
  return (
    <div className={tone}>
      <span className="font-medium">{label}: </span>
      {success ? detail ?? "Done" : error ?? "Failed"}
    </div>
  );
}

function PublishResultSummary({ data }: { data: PublishRunResult }) {
  const successCount = data.results.filter((result) => result.success).length;
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div className="text-sm font-semibold text-foreground">
          Publish Results: {successCount} of {data.results.length} completed
        </div>
        {data.requirementSuite ? (
          <ToneBadge tone={data.requirementSuite.success ? "success" : "error"}>
            {data.requirementSuite.success ? `Suite ${data.requirementSuite.suiteId ?? ""}`.trim() : "Suite failed"}
          </ToneBadge>
        ) : null}
      </div>
      <div className="divide-y divide-border">
        {data.results.map((result) => (
          <div key={result.localId} className="grid gap-3 p-3 text-sm lg:grid-cols-[140px_120px_120px_120px_minmax(0,1fr)]">
            <span className="font-mono text-xs text-primary">{result.localId}</span>
            <span>{result.azureTestCaseId ? `Azure ${result.azureTestCaseId}` : "Not created"}</span>
            <StatusText label="Create" success={result.create?.success} error={result.create?.error ?? result.error} />
            <StatusText label="Link" success={result.link?.success} error={result.link?.error} />
            <StatusText label="Suite" success={result.suite?.success} error={result.suite?.error} detail={result.suite?.suiteName ?? result.suite?.suiteId} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function SuggestedAdditionsPublishResultSummary({ data }: { data: SuggestedAdditionsPublishResult }) {
  const successCount = data.results.filter((result) => result.success).length;
  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
        <div className="text-sm font-semibold text-foreground">
          Azure Add Results: {successCount} of {data.results.length} created and linked
        </div>
        <ToneBadge tone={successCount === data.results.length ? "success" : "warning"}>
          {successCount === data.results.length ? "Complete" : "Partial"}
        </ToneBadge>
      </div>
      <div className="divide-y divide-border">
        {data.results.map((result) => (
          <div key={result.localId} className="grid gap-3 p-3 text-sm lg:grid-cols-[140px_140px_140px_minmax(0,1fr)]">
            <span className="font-mono text-xs text-primary">{result.localId}</span>
            <span>{result.azureTestCaseId ? `Azure ${result.azureTestCaseId}` : "Not created"}</span>
            <StatusText label="Create" success={result.create?.success} error={result.create?.error ?? result.error} />
            <StatusText label="Link" success={result.link?.success} error={result.link?.error} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function PublishGeneratedCasesPanel({
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
    <SectionCard
      title="Publish Generated Test Cases"
      description="Create Azure Test Case work items, link them to the user story, then add them to a suite or create a requirement-based suite."
    >
      <div className="space-y-4 p-4">
        <label className="flex items-center gap-2 text-sm font-medium text-foreground">
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
            <select
              className={generatedCaseSelectClass}
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
            </select>
            <Input
              value={testPlanInput}
              onChange={(event) => selectPlan(event.target.value)}
              placeholder="Or paste Test Plan ID/link"
              disabled={targetControlsDisabled}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <select
              className={generatedCaseSelectClass}
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
            </select>
            <Input
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
    </SectionCard>
  );
}
