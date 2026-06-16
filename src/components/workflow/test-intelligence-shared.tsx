"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Loader2, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SearchableCombobox } from "@/components/ui/searchable-combobox";
import { Callout } from "@/components/qa/callout";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { useUnsavedChangesGuard } from "@/components/navigation/unsaved-changes-provider";
import { RefreshButton } from "@/components/qa/refresh-button";
import { toneClass, type Tone } from "@/components/qa/tone";
import { cn } from "@/lib/utils";
import { formatEnumLabel, formatPercentage } from "@/shared/lib/format";
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

export async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
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

export function isRequirementLikeType(workItemType: string) {
  return ["user story", "product backlog item", "requirement", "feature", "bug"].includes(workItemType.trim().toLowerCase());
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

// Pure formatting helpers live in `@/shared/lib/format` so non-React modules can
// use them too; re-exported here to preserve existing import paths.
export { formatEnumLabel, formatPercentage };

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

export type SummaryTone = "red" | "amber" | "blue" | "green" | "cyan" | "slate";

export type SummaryRow = {
  label: string;
  value: number;
  tone: SummaryTone;
};

export function SummaryTotalCard({ label = "Total", total }: { label?: string; total: number }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-base font-semibold text-muted-foreground">{label}</div>
      <div className="mt-2 text-4xl font-bold text-foreground">{total}</div>
    </div>
  );
}

export function SummaryCard({
  title,
  rows,
  emptyLabel = "No values yet",
  footer,
}: {
  title: string;
  rows: SummaryRow[];
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
            <SummaryRowItem key={row.label} row={row} />
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

function SummaryRowItem({ row }: { row: SummaryRow }) {
  const toneStyles = {
    red: "bg-destructive/10 text-destructive",
    amber: "bg-warning/15 text-warning-foreground dark:text-warning",
    blue: "bg-accent text-primary",
    green: "bg-success/10 text-success",
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
  const showSuiteResult = data.suiteMode !== "none";
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
          <div
            key={result.localId}
            className={cn(
              "grid gap-3 p-3 text-sm",
              showSuiteResult
                ? "lg:grid-cols-[140px_120px_120px_120px_minmax(0,1fr)]"
                : "lg:grid-cols-[140px_140px_140px_minmax(0,1fr)]",
            )}
          >
            <span className="font-mono text-xs text-primary">{result.localId}</span>
            <span>{result.azureTestCaseId ? `Azure ${result.azureTestCaseId}` : "Not created"}</span>
            <StatusText label="Create" success={result.create?.success} error={result.create?.error ?? result.error} />
            <StatusText label="Link" success={result.link?.success} error={result.link?.error} />
            {showSuiteResult ? (
              <StatusText
                label="Suite"
                success={result.suite?.success}
                error={result.suite?.error}
                detail={result.suite?.suiteName ?? result.suite?.suiteId}
              />
            ) : null}
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
  invalidCaseCount = 0,
  onDirty,
  onPublished,
  analyticsRunId,
  itemsGenerated,
  itemsEdited,
}: {
  scope: ActiveProjectScope | null;
  targetWorkItemId: string;
  testCases: GeneratedTestCase[];
  invalidCaseCount?: number;
  onDirty?: () => void;
  onPublished?: () => void;
  analyticsRunId?: string;
  itemsGenerated?: number;
  itemsEdited?: number;
}) {
  const [testPlanInput, setTestPlanInput] = useState("");
  const [parentSuiteInput, setParentSuiteInput] = useState("");
  const [createRequirementSuite, setCreateRequirementSuite] = useState(false);
  const [testPlans, setTestPlans] = useState<TestPlan[]>([]);
  const [testSuites, setTestSuites] = useState<TestSuite[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [suitesLoading, setSuitesLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [suiteError, setSuiteError] = useState<string | null>(null);
  const [suiteNotice, setSuiteNotice] = useState<string | null>(null);
  const [state, setState] = useState<ApiState<PublishRunResult>>({ loading: false, error: null, data: null });
  useUnsavedChangesGuard({ dirty: false, busy: state.loading });
  const suiteRequestRef = useRef(0);
  const suiteAbortRef = useRef<AbortController | null>(null);
  const parentSuiteInputRef = useRef("");
  const selectedTestPlanId = useMemo(() => extractAzureId(testPlanInput, "plan"), [testPlanInput]);
  const selectedSuiteId = useMemo(() => extractAzureId(parentSuiteInput, "suite"), [parentSuiteInput]);
  const selectedPlanLabel = testPlans.find((plan) => plan.id === selectedTestPlanId);
  const staticTestSuites = useMemo(
    () => testSuites.filter((suite) => suite.suiteType === "staticTestSuite"),
    [testSuites],
  );
  const selectedSuiteLabel = staticTestSuites.find((suite) => suite.id === selectedSuiteId);
  const targetControlsDisabled = !createRequirementSuite;

  useEffect(() => {
    if (!scope || !createRequirementSuite) {
      setTestPlans([]);
      setPlansLoading(false);
      setPlanError(null);
      return;
    }

    const controller = new AbortController();
    setPlansLoading(true);
    setPlanError(null);
    postJson<{ testPlans: TestPlan[] }>("/api/azure-devops/test-plans", { scope }, controller.signal)
      .then((data) => setTestPlans(data.testPlans))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setPlanError(error instanceof Error ? error.message : "Azure Test Plan fetch failed.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setPlansLoading(false);
      });
    return () => controller.abort();
  }, [scope, createRequirementSuite]);

  const loadTestSuites = useCallback(async (
    testPlanId: string,
    mode: "plan-change" | "refresh",
  ) => {
    if (!scope || !testPlanId || !createRequirementSuite) return;

    suiteAbortRef.current?.abort();
    const controller = new AbortController();
    suiteAbortRef.current = controller;
    const requestId = ++suiteRequestRef.current;
    if (mode === "plan-change") setTestSuites([]);
    setSuitesLoading(true);
    setSuiteError(null);
    setSuiteNotice(null);

    try {
      const data = await postJson<{ testSuites: TestSuite[] }>(
        "/api/azure-devops/test-suites",
        { scope, testPlanId },
        controller.signal,
      );
      if (suiteRequestRef.current !== requestId) return;

      const nextSuites = data.testSuites ?? [];
      const staticIds = new Set(
        nextSuites
          .filter((suite) => suite.suiteType === "staticTestSuite")
          .map((suite) => suite.id),
      );
      setTestSuites(nextSuites);
      const currentId = extractAzureId(parentSuiteInputRef.current, "suite");
      if (currentId && !staticIds.has(currentId)) {
        parentSuiteInputRef.current = "";
        setParentSuiteInput("");
        if (mode === "refresh") {
          setSuiteNotice("The previously selected parent suite is no longer available as a static suite.");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && suiteRequestRef.current === requestId) {
        setSuiteError(error instanceof Error ? error.message : "Azure Test Suite fetch failed.");
      }
    } finally {
      if (suiteRequestRef.current === requestId) setSuitesLoading(false);
    }
  }, [scope, createRequirementSuite]);

  useEffect(() => {
    if (!scope || !selectedTestPlanId || !createRequirementSuite) {
      suiteAbortRef.current?.abort();
      suiteRequestRef.current += 1;
      setTestSuites([]);
      setSuitesLoading(false);
      setSuiteError(null);
      setSuiteNotice(null);
      return;
    }
    void loadTestSuites(selectedTestPlanId, "plan-change");
  }, [scope, selectedTestPlanId, createRequirementSuite, loadTestSuites]);

  useEffect(() => () => {
    suiteRequestRef.current += 1;
    suiteAbortRef.current?.abort();
  }, []);

  function selectPlan(value: string) {
    onDirty?.();
    suiteAbortRef.current?.abort();
    suiteRequestRef.current += 1;
    setTestPlanInput(value);
    parentSuiteInputRef.current = "";
    setParentSuiteInput("");
    setTestSuites([]);
    setSuitesLoading(false);
    setSuiteError(null);
    setSuiteNotice(null);
    setState({ loading: false, error: null, data: null });
  }

  function selectSuite(value: string) {
    onDirty?.();
    parentSuiteInputRef.current = value;
    setParentSuiteInput(value);
    setState({ loading: false, error: null, data: null });
  }

  async function publish() {
    if (
      !scope ||
      !targetWorkItemId ||
      !testCases.length ||
      (createRequirementSuite && (!selectedTestPlanId || !selectedSuiteId))
    ) {
      return;
    }

    setState({ loading: true, error: null, data: null });
    try {
      const data = await postJson<PublishRunResult>("/api/publish/test-cases", {
        scope,
        analyticsRunId,
        itemsGenerated,
        itemsEdited,
        targetWorkItemId,
        suiteMode: createRequirementSuite ? "requirement" : "none",
        ...(createRequirementSuite
          ? {
              testPlanId: testPlanInput,
              parentSuiteId: parentSuiteInput,
            }
          : {}),
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
      const casesPublished = data.results.length > 0 && data.results.every((result) => result.success);
      const suitePublished = !createRequirementSuite || data.requirementSuite?.success === true;
      if (casesPublished && suitePublished) onPublished?.();
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Publish failed.", data: null });
    }
  }

  const disabled =
    !scope ||
    !targetWorkItemId ||
    !testCases.length ||
    invalidCaseCount > 0 ||
    (createRequirementSuite && (!selectedTestPlanId || !selectedSuiteId)) ||
    state.loading;

  return (
    <SectionCard
      title="Publish Generated Test Cases"
      description="Create Azure Test Case work items, link them to the user story, and optionally create a requirement-based suite."
    >
      <div className="space-y-4 p-4">
        <label className="flex cursor-pointer items-start gap-2">
          <Checkbox
            checked={createRequirementSuite}
            onCheckedChange={(checked) => {
              onDirty?.();
              setCreateRequirementSuite(checked === true);
              setState({ loading: false, error: null, data: null });
            }}
            className="mt-0.5"
          />
          <span className="text-sm font-medium text-foreground">
            Create requirement-based suite for this user story
          </span>
        </label>

        <div className={`space-y-4 transition ${targetControlsDisabled ? "opacity-50" : "opacity-100"}`}>
          <div className="grid gap-3 lg:grid-cols-2">
            <SearchableCombobox
              value={selectedTestPlanId}
              options={testPlans.map((plan) => ({
                value: plan.id,
                label: plan.name,
                description: `Test Plan ID ${plan.id}`,
              }))}
              onValueChange={selectPlan}
              loading={plansLoading}
              disabled={targetControlsDisabled}
              placeholder="Select Azure Test Plan"
              loadingText="Loading Azure Test Plans..."
              searchPlaceholder="Search plans by name or ID"
              emptyMessage="No Azure Test Plans found."
              aria-label="Select Azure Test Plan"
              selectedLabel={selectedPlanLabel ? `${selectedPlanLabel.id} - ${selectedPlanLabel.name}` : undefined}
              triggerClassName="h-9"
            />
            <Input
              value={testPlanInput}
              onChange={(event) => selectPlan(event.target.value)}
              placeholder="Or paste Test Plan ID/link"
              disabled={targetControlsDisabled}
            />
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex min-w-0 items-center gap-2">
              <SearchableCombobox
                value={selectedSuiteId}
                options={staticTestSuites.map((suite) => ({
                  value: suite.id,
                  label: suite.name,
                  description: `${suite.id} - ${suite.path ?? suite.name}`,
                  searchText: suite.path,
                }))}
                onValueChange={selectSuite}
                loading={suitesLoading}
                disabled={targetControlsDisabled || !selectedTestPlanId}
                placeholder="Select Parent Suite"
                loadingText="Loading parent suites..."
                searchPlaceholder="Search static suites by name, ID, or path"
                emptyMessage="No static parent suites found."
                aria-label="Select Parent Suite"
                selectedLabel={selectedSuiteLabel ? `${selectedSuiteLabel.id} - ${selectedSuiteLabel.name}` : undefined}
                triggerClassName="h-9 min-w-0 flex-1"
              />
              <RefreshButton
                disabled={targetControlsDisabled || !selectedTestPlanId || suitesLoading}
                onClick={() => void loadTestSuites(selectedTestPlanId, "refresh")}
                loading={suitesLoading}
              />
            </div>
            <Input
              value={parentSuiteInput}
              onChange={(event) => selectSuite(event.target.value)}
              placeholder="Or paste Parent Suite ID/link"
              disabled={targetControlsDisabled}
            />
          </div>
          {createRequirementSuite ? (
            <div className="text-xs leading-5 text-muted-foreground">
              Only static suites can be selected as a parent. Requirement-based and query-based suites are hidden.
            </div>
          ) : null}
          {createRequirementSuite && suiteNotice ? (
            <div className="text-xs leading-5 text-warning-foreground dark:text-warning">{suiteNotice}</div>
          ) : null}
        </div>

        {createRequirementSuite && planError ? <ErrorBlock message={planError} /> : null}
        {createRequirementSuite && suiteError ? <ErrorBlock message={suiteError} /> : null}
        {state.error ? <ErrorBlock message={state.error} /> : null}
        {invalidCaseCount > 0 ? (
          <Callout tone="warning">
            Resolve validation issues in the {invalidCaseCount} selected test case{invalidCaseCount === 1 ? "" : "s"} before publishing.
          </Callout>
        ) : null}

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
                {createRequirementSuite ? (
                  <>
                    <p>Test plan: {selectedPlanLabel ? `${selectedPlanLabel.id} - ${selectedPlanLabel.name}` : selectedTestPlanId}</p>
                    <p>Parent suite: {selectedSuiteLabel ? `${selectedSuiteLabel.id} - ${selectedSuiteLabel.name}` : selectedSuiteId}</p>
                  </>
                ) : (
                  <p>Each created test case will be linked to this user story without creating a test suite.</p>
                )}
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
