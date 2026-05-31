"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRight, ClipboardList, GitBranch, Loader2, MoveRight, RefreshCw, Send, ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { readActiveProject, type ActiveProjectScope } from "@/shared/lib/active-project";
import type {
  MigrationPreview,
  MigrationPreviewRow,
  MigrationReport,
  OutcomeMigrationMode,
  SuiteMigrationOperationMode,
  SuiteTreeNode,
  TestSuiteMigrationRequest,
} from "@/types/test-suite-migration";

type TestPlan = {
  id: string;
  name: string;
};

type ApiState = {
  loading: boolean;
  error: string | null;
};

type PreviewFilter =
  | "all"
  | "roots"
  | "children"
  | "mapped"
  | "unmapped"
  | "willUpdate"
  | "willSkip"
  | "willOverwrite"
  | "errors"
  | "warnings";

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

export function TestSuiteMigrationClient() {
  const [scope, setScope] = useState<ActiveProjectScope | null>(null);
  const [plans, setPlans] = useState<TestPlan[]>([]);
  const [sourcePlanId, setSourcePlanId] = useState("");
  const [targetPlanId, setTargetPlanId] = useState("");
  const [sourceTree, setSourceTree] = useState<SuiteTreeNode[]>([]);
  const [targetTree, setTargetTree] = useState<SuiteTreeNode[]>([]);
  const [selectedSuiteIds, setSelectedSuiteIds] = useState<string[]>([]);
  const [targetParentSuiteId, setTargetParentSuiteId] = useState("");
  const [operationMode, setOperationMode] = useState<SuiteMigrationOperationMode>("copy");
  const [outcomeMode, setOutcomeMode] = useState<OutcomeMigrationMode>("latestOutcomeAndTester");
  const [overwriteTargetOutcomes, setOverwriteTargetOutcomes] = useState(false);
  const [plansState, setPlansState] = useState<ApiState>({ loading: false, error: null });
  const [sourceTreeState, setSourceTreeState] = useState<ApiState>({ loading: false, error: null });
  const [targetTreeState, setTargetTreeState] = useState<ApiState>({ loading: false, error: null });
  const [previewState, setPreviewState] = useState<ApiState>({ loading: false, error: null });
  const [executeState, setExecuteState] = useState<ApiState>({ loading: false, error: null });
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [report, setReport] = useState<MigrationReport | null>(null);
  const [previewFilter, setPreviewFilter] = useState<PreviewFilter>("all");

  useEffect(() => {
    setScope(readActiveProject());
    const onChange = (event: Event) => {
      const custom = event as CustomEvent<ActiveProjectScope>;
      setScope(custom.detail ?? readActiveProject());
      resetForProjectChange();
    };
    window.addEventListener("itestflow:active-project-changed", onChange);
    return () => window.removeEventListener("itestflow:active-project-changed", onChange);
  }, []);

  useEffect(() => {
    if (!scope) return;
    let cancelled = false;
    setPlansState({ loading: true, error: null });
    void postJson<{ testPlans: TestPlan[] }>("/api/azure-devops/test-plans", { scope })
      .then((data) => {
        if (cancelled) return;
        const nextPlans = data.testPlans ?? [];
        setPlans(nextPlans);
        setSourcePlanId((current) => current || nextPlans[0]?.id || "");
        setTargetPlanId((current) => current || nextPlans[0]?.id || "");
      })
      .catch((error: unknown) => {
        if (!cancelled) setPlansState({ loading: false, error: error instanceof Error ? error.message : "Azure Test Plan fetch failed." });
      })
      .finally(() => {
        if (!cancelled) setPlansState((current) => ({ ...current, loading: false }));
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const loadSuiteTree = useCallback(async (kind: "source" | "target", testPlanId: string) => {
    if (!scope) return;
    const setState = kind === "source" ? setSourceTreeState : setTargetTreeState;
    const setTree = kind === "source" ? setSourceTree : setTargetTree;
    setState({ loading: true, error: null });
    if (kind === "source") {
      setSelectedSuiteIds([]);
      setPreview(null);
      setReport(null);
    }
    try {
      const data = await postJson<{ suiteTree: SuiteTreeNode[] }>("/api/test-suite-migration/tree", { scope, testPlanId });
      setTree(data.suiteTree ?? []);
      if (kind === "target") {
        const firstSuiteId = flattenTree(data.suiteTree ?? [])[0]?.id ?? "";
        setTargetParentSuiteId((current) => current || firstSuiteId);
      }
    } catch (error) {
      setState({ loading: false, error: error instanceof Error ? error.message : "Azure Test Suite tree fetch failed." });
      return;
    }
    setState({ loading: false, error: null });
  }, [scope]);

  useEffect(() => {
    if (!scope || !sourcePlanId) {
      setSourceTree([]);
      return;
    }
    void loadSuiteTree("source", sourcePlanId);
  }, [loadSuiteTree, scope, sourcePlanId]);

  useEffect(() => {
    if (!scope || !targetPlanId) {
      setTargetTree([]);
      return;
    }
    void loadSuiteTree("target", targetPlanId);
  }, [loadSuiteTree, scope, targetPlanId]);

  const sourceFlatSuites = useMemo(() => flattenTree(sourceTree), [sourceTree]);
  const targetFlatSuites = useMemo(() => flattenTree(targetTree), [targetTree]);
  const selectedSuiteNames = useMemo(
    () => selectedSuiteIds.map((suiteId) => sourceFlatSuites.find((suite) => suite.id === suiteId)?.name ?? suiteId),
    [selectedSuiteIds, sourceFlatSuites],
  );
  const filteredRows = useMemo(() => filterPreviewRows(preview, previewFilter), [preview, previewFilter]);
  const canPreview = Boolean(scope && sourcePlanId && targetPlanId && targetParentSuiteId && selectedSuiteIds.length && !previewState.loading);
  const canExecute = Boolean(preview && !preview.errors.length && !executeState.loading);

  function buildRequest(): TestSuiteMigrationRequest | null {
    if (!scope) return null;
    return {
      scope,
      sourceProjectId: scope.azureProjectId,
      sourceTestPlanId: sourcePlanId,
      selectedSuiteIds,
      targetProjectId: scope.azureProjectId,
      targetTestPlanId: targetPlanId,
      targetParentSuiteId,
      operationMode,
      outcomeMode,
      overwriteTargetOutcomes,
      conflictStrategy: "renameWithMigratedSuffix",
    };
  }

  async function previewMigration() {
    const request = buildRequest();
    if (!request) return;
    setPreviewState({ loading: true, error: null });
    setPreview(null);
    setReport(null);
    try {
      const data = await postJson<{ preview: MigrationPreview }>("/api/test-suite-migration/preview", request);
      setPreview(data.preview);
      setPreviewFilter("all");
      if (data.preview.errors.length) {
        toast.error("Preview found blocking errors.");
      } else {
        toast.success("Migration preview is ready.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Migration preview failed.";
      setPreviewState({ loading: false, error: message });
      toast.error(message);
      return;
    }
    setPreviewState({ loading: false, error: null });
  }

  async function executeMigration() {
    const request = buildRequest();
    if (!request) return;
    setExecuteState({ loading: true, error: null });
    setReport(null);
    try {
      const data = await postJson<{ report: MigrationReport; preview: MigrationPreview }>("/api/test-suite-migration/execute", request);
      setPreview(data.preview);
      setReport(data.report);
      toast.success(`Migration ${formatStatus(data.report.status)}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Suite migration failed.";
      setExecuteState({ loading: false, error: message });
      toast.error(message);
      return;
    }
    setExecuteState({ loading: false, error: null });
  }

  function resetForProjectChange() {
    setPlans([]);
    setSourcePlanId("");
    setTargetPlanId("");
    setSourceTree([]);
    setTargetTree([]);
    setSelectedSuiteIds([]);
    setTargetParentSuiteId("");
    setPreview(null);
    setReport(null);
  }

  return (
    <div className="space-y-5">
      {!scope ? (
        <Alert className="border-amber-500/40 bg-amber-500/10">
          <AlertTriangle className="size-4" />
          <AlertTitle>Select an Azure DevOps project</AlertTitle>
          <AlertDescription>The active project controls the source and target for this same-project migration.</AlertDescription>
        </Alert>
      ) : null}

      <Alert className="border-blue-500/30 bg-blue-500/10">
        <ShieldAlert className="size-4 text-blue-700" />
        <AlertTitle>Latest outcome migration</AlertTitle>
        <AlertDescription>
          Azure DevOps native suite copy does not preserve execution outcomes. iTestFlow migrates the latest matching test point outcome and does not recreate historical runs.
        </AlertDescription>
      </Alert>

      {operationMode === "move" ? (
        <Alert className="border-red-500/30 bg-red-500/10">
          <AlertTriangle className="size-4 text-red-700" />
          <AlertTitle>Move mode is destructive after validation</AlertTitle>
          <AlertDescription>Source root suites are removed only after target migration completes without critical failures.</AlertDescription>
        </Alert>
      ) : null}

      {plansState.error ? <ErrorBanner message={plansState.error} /> : null}
      {sourceTreeState.error ? <ErrorBanner message={sourceTreeState.error} /> : null}
      {targetTreeState.error ? <ErrorBanner message={targetTreeState.error} /> : null}
      {previewState.error ? <ErrorBanner message={previewState.error} /> : null}
      {executeState.error ? <ErrorBanner message={executeState.error} /> : null}

      <Card className="qa-card">
        <CardHeader>
          <CardTitle className="text-base">Migration Setup</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_320px]">
          <section className="space-y-3">
            <SectionLabel icon={GitBranch} label="Source" />
            <Field label="Source test plan">
              <PlanSelect value={sourcePlanId} plans={plans} loading={plansState.loading} onChange={setSourcePlanId} />
            </Field>
            <div className="rounded-md border border-border bg-background">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-sm font-semibold">Source suites</span>
                <Badge variant="secondary">{selectedSuiteIds.length} selected</Badge>
              </div>
              <div className="max-h-[420px] overflow-auto p-3">
                {sourceTreeState.loading ? (
                  <LoadingInline label="Loading source suites..." />
                ) : sourceTree.length ? (
                  <SuiteCheckboxTree nodes={sourceTree} selectedIds={selectedSuiteIds} onChange={setSelectedSuiteIds} />
                ) : (
                  <EmptyInline label="No source suites loaded." />
                )}
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <SectionLabel icon={MoveRight} label="Target" />
            <Field label="Target test plan">
              <PlanSelect value={targetPlanId} plans={plans} loading={plansState.loading} onChange={(value) => { setTargetPlanId(value); setTargetParentSuiteId(""); }} />
            </Field>
            <Field label="Target parent suite">
              <select
                className="focus-ring h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={targetParentSuiteId}
                onChange={(event) => {
                  setTargetParentSuiteId(event.target.value);
                  setPreview(null);
                  setReport(null);
                }}
                disabled={!targetPlanId || targetTreeState.loading}
              >
                <option value="">{targetTreeState.loading ? "Loading target suites..." : "Select target parent suite"}</option>
                {targetFlatSuites.map((suite) => (
                  <option key={suite.id} value={suite.id}>
                    {suite.id} - {suite.path}
                  </option>
                ))}
              </select>
            </Field>
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              Same-project migration is enabled for this release. Cross-project mapping is intentionally blocked until test case and configuration ID translation is implemented.
            </div>
          </section>

          <section className="space-y-3">
            <SectionLabel icon={ClipboardList} label="Options" />
            <Field label="Operation">
              <select
                className="focus-ring h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={operationMode}
                onChange={(event) => {
                  setOperationMode(event.target.value as SuiteMigrationOperationMode);
                  setPreview(null);
                  setReport(null);
                }}
              >
                <option value="copy">Copy selected suite(s)</option>
                <option value="move">Move selected suite(s)</option>
              </select>
            </Field>
            <Field label="Outcome migration">
              <select
                className="focus-ring h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={outcomeMode}
                onChange={(event) => {
                  setOutcomeMode(event.target.value as OutcomeMigrationMode);
                  setPreview(null);
                  setReport(null);
                }}
              >
                <option value="none">Do not migrate outcomes</option>
                <option value="latestOutcome">Migrate latest outcome only</option>
                <option value="latestOutcomeAndTester">Migrate latest outcome + tester</option>
              </select>
            </Field>
            <Label className="flex items-start gap-3 rounded-md border border-border bg-background p-3 text-sm">
              <Checkbox
                checked={overwriteTargetOutcomes}
                onCheckedChange={(checked) => {
                  setOverwriteTargetOutcomes(checked === true);
                  setPreview(null);
                  setReport(null);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="block font-semibold">Overwrite target outcomes</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">Off by default. Existing target outcomes are skipped unless this is enabled.</span>
              </span>
            </Label>
          </section>
        </CardContent>
      </Card>

      <Card className="qa-card">
        <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 text-sm text-muted-foreground">
            <div className="font-semibold text-foreground">Selected suites</div>
            <div className="mt-1 truncate">{selectedSuiteNames.length ? selectedSuiteNames.join(", ") : "No source suites selected"}</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => sourcePlanId && void loadSuiteTree("source", sourcePlanId)} disabled={!sourcePlanId || sourceTreeState.loading}>
              {sourceTreeState.loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Refresh Source
            </Button>
            <Button onClick={previewMigration} disabled={!canPreview}>
              {previewState.loading ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4" />}
              Preview Migration
            </Button>
          </div>
        </CardContent>
      </Card>

      {preview ? (
        <PreviewPanel
          preview={preview}
          filter={previewFilter}
          filteredRows={filteredRows}
          onFilterChange={setPreviewFilter}
          canExecute={canExecute}
          operationMode={operationMode}
          executing={executeState.loading}
          onExecute={executeMigration}
        />
      ) : null}

      {report ? <ReportPanel report={report} /> : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-semibold">{label}</Label>
      {children}
    </div>
  );
}

function SectionLabel({ icon: Icon, label }: { icon: typeof GitBranch; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
      <Icon className="size-4 text-blue-700" />
      {label}
    </div>
  );
}

function PlanSelect({ value, plans, loading, onChange }: { value: string; plans: TestPlan[]; loading: boolean; onChange: (value: string) => void }) {
  return (
    <select
      className="focus-ring h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={loading}
    >
      <option value="">{loading ? "Loading plans..." : "Select test plan"}</option>
      {plans.map((plan) => (
        <option key={plan.id} value={plan.id}>
          {plan.id} - {plan.name}
        </option>
      ))}
    </select>
  );
}

function SuiteCheckboxTree({
  nodes,
  selectedIds,
  onChange,
  selectedAncestorId,
}: {
  nodes: SuiteTreeNode[];
  selectedIds: string[];
  onChange: (selectedIds: string[]) => void;
  selectedAncestorId?: string;
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="space-y-1">
      {nodes.map((node) => {
        const descendantIds = flattenTree(node.children).map((child) => child.id);
        const hasSelectedDescendant = descendantIds.some((id) => selected.has(id));
        const disabledByAncestor = Boolean(selectedAncestorId);
        const checked = selected.has(node.id) || disabledByAncestor ? true : hasSelectedDescendant ? "indeterminate" : false;
        const nextSelectedAncestor = selected.has(node.id) || selectedAncestorId ? node.id : undefined;

        return (
          <div key={node.id} className="space-y-1">
            <div className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
              <Checkbox
                checked={checked}
                disabled={disabledByAncestor}
                onCheckedChange={(value) => {
                  const next = new Set(selectedIds);
                  if (value === true) {
                    next.add(node.id);
                    descendantIds.forEach((id) => next.delete(id));
                  } else {
                    next.delete(node.id);
                  }
                  onChange([...next]);
                }}
                className="mt-0.5"
                aria-label={`Select suite ${node.name}`}
              />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{node.name}</div>
                <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                  <span>ID {node.id}</span>
                  {node.suiteType ? <span>{formatSuiteType(node.suiteType)}</span> : null}
                  {node.children.length ? <span>{node.children.length} child suites</span> : null}
                </div>
              </div>
            </div>
            {node.children.length ? (
              <div className="ml-5 border-l pl-3">
                <SuiteCheckboxTree nodes={node.children} selectedIds={selectedIds} onChange={onChange} selectedAncestorId={nextSelectedAncestor} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function PreviewPanel({
  preview,
  filter,
  filteredRows,
  onFilterChange,
  canExecute,
  operationMode,
  executing,
  onExecute,
}: {
  preview: MigrationPreview;
  filter: PreviewFilter;
  filteredRows: MigrationPreviewRow[];
  onFilterChange: (filter: PreviewFilter) => void;
  canExecute: boolean;
  operationMode: SuiteMigrationOperationMode;
  executing: boolean;
  onExecute: () => void;
}) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <CardTitle className="text-base">Migration Preview</CardTitle>
          <div className="flex flex-wrap gap-2">
            <Badge variant={preview.errors.length ? "destructive" : "secondary"}>{formatStatus(preview.status)}</Badge>
            <ConfirmationDialog
              trigger={
                <Button disabled={!canExecute}>
                  {executing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                  {executing ? "Migrating..." : operationMode === "move" ? "Confirm Move" : "Confirm Migration"}
                </Button>
              }
              title={operationMode === "move" ? "Move selected suites?" : "Run suite migration?"}
              description={
                <div className="space-y-1">
                  <p>Source suites: {preview.selectedRootSuiteCount}</p>
                  <p>Total suites: {preview.totalSuiteCount}</p>
                  <p>Test points to evaluate: {preview.totalSourceTestPointCount}</p>
                  <p>Latest outcomes to migrate: {preview.mappableOutcomeCount}</p>
                  {operationMode === "move" ? <p>Source root suites are deleted only after target validation succeeds.</p> : null}
                </div>
              }
              confirmLabel={operationMode === "move" ? "Move suites" : "Run migration"}
              onConfirm={onExecute}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric label="Selected roots" value={preview.selectedRootSuiteCount} />
          <Metric label="Child suites included" value={preview.childSuitesIncludedCount} />
          <Metric label="Total suites" value={preview.totalSuiteCount} />
          <Metric label="Test points" value={preview.totalSourceTestPointCount} />
          <Metric label="Unique test cases" value={preview.totalSourceTestCaseCount} />
          <Metric label="Mappable outcomes" value={preview.mappableOutcomeCount} />
          <Metric label="Unmapped points" value={preview.unmappedTestPointCount} tone={preview.unmappedTestPointCount ? "warning" : "default"} />
          <Metric label="Warnings" value={preview.warnings.length} tone={preview.warnings.length ? "warning" : "default"} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-md border border-border">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
              <div className="text-sm font-semibold">Preview rows</div>
              <select
                className="focus-ring h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={filter}
                onChange={(event) => onFilterChange(event.target.value as PreviewFilter)}
              >
                <option value="all">All</option>
                <option value="roots">Selected root suites</option>
                <option value="children">Auto-included child suites</option>
                <option value="mapped">Mapped</option>
                <option value="unmapped">Unmapped</option>
                <option value="willUpdate">Will update</option>
                <option value="willSkip">Will skip</option>
                <option value="willOverwrite">Will overwrite</option>
                <option value="errors">Errors</option>
                <option value="warnings">Warnings</option>
              </select>
            </div>
            <PreviewTable rows={filteredRows} />
          </div>

          <div className="space-y-4">
            <SummaryList title="Selected root suites" items={preview.selectedRoots.map((root) => `${root.id} - ${root.path}`)} emptyLabel="No root suites." />
            <OutcomeBreakdown breakdown={preview.outcomeBreakdown} />
            <IssueList title="Warnings" items={preview.warnings.map((warning) => warning.message)} emptyLabel="No warnings." />
            <IssueList title="Errors" items={preview.errors.map((error) => error.message)} emptyLabel="No errors." tone="error" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewTable({ rows }: { rows: MigrationPreviewRow[] }) {
  if (!rows.length) return <div className="p-4 text-sm text-muted-foreground">No rows match this filter.</div>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Source Root Suite</TableHead>
          <TableHead className="min-w-[240px]">Source Suite Path</TableHead>
          <TableHead>Source Suite ID</TableHead>
          <TableHead>Source Test Case ID</TableHead>
          <TableHead className="min-w-[240px]">Source Test Case Title</TableHead>
          <TableHead>Source Configuration</TableHead>
          <TableHead>Source Latest Outcome</TableHead>
          <TableHead>Source Last Run Date</TableHead>
          <TableHead className="min-w-[240px]">Target Suite Path</TableHead>
          <TableHead>Target Test Case ID</TableHead>
          <TableHead>Target Configuration</TableHead>
          <TableHead>Mapping Status</TableHead>
          <TableHead>Planned Action</TableHead>
          <TableHead>Warning/Error</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={`${row.sourceSuiteId}-${row.sourceTestCaseId}-${row.sourceConfiguration}-${index}`}>
            <TableCell>{row.sourceRootSuite}</TableCell>
            <TableCell className="whitespace-normal">{row.sourceSuitePath}</TableCell>
            <TableCell className="font-mono text-xs">{row.sourceSuiteId}</TableCell>
            <TableCell className="font-mono text-xs">{row.sourceTestCaseId ?? "-"}</TableCell>
            <TableCell className="whitespace-normal">{row.sourceTestCaseTitle ?? "-"}</TableCell>
            <TableCell>{row.sourceConfiguration ?? "-"}</TableCell>
            <TableCell>{row.sourceLatestOutcome ?? "-"}</TableCell>
            <TableCell>{formatDate(row.sourceLastRunDate)}</TableCell>
            <TableCell className="whitespace-normal">{row.targetSuitePath}</TableCell>
            <TableCell className="font-mono text-xs">{row.targetTestCaseId ?? "-"}</TableCell>
            <TableCell>{row.targetConfiguration ?? "-"}</TableCell>
            <TableCell><StatusBadge status={row.mappingStatus} /></TableCell>
            <TableCell className="whitespace-normal">{row.plannedAction}</TableCell>
            <TableCell className="whitespace-normal">{row.warningOrError ?? "-"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ReportPanel({ report }: { report: MigrationReport }) {
  return (
    <Card className="qa-card">
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <CardTitle className="text-base">Final Migration Report</CardTitle>
          <Badge variant={report.status === "completed" ? "secondary" : report.status === "partiallyCompleted" ? "outline" : "destructive"}>
            {formatStatus(report.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Suites created" value={report.summary.suitesCreated} />
          <Metric label="Case batches added" value={report.summary.testCasesAdded} />
          <Metric label="Outcomes updated" value={report.summary.outcomesUpdated} />
          <Metric label="Outcomes skipped" value={report.summary.outcomesSkipped} />
          <Metric label="Outcomes failed" value={report.summary.outcomesFailed} tone={report.summary.outcomesFailed ? "warning" : "default"} />
          <Metric label="Source roots deleted" value={report.summary.sourceSuitesDeleted} />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <SummaryList title="Suite migration summary" items={report.suiteMappings.map((mapping) => `${mapping.sourceSuitePath} -> ${mapping.targetSuitePath} (${mapping.targetSuiteId})`)} emptyLabel="No suite mappings." />
          <IssueList title="Warnings" items={report.warnings.map((warning) => warning.message)} emptyLabel="No warnings." />
          <IssueList title="Errors" items={report.errors.map((error) => error.message)} emptyLabel="No errors." tone="error" />
          <SummaryList title="Recent actions" items={report.actions.slice(-12).map((action) => `${action.status}: ${action.message}`)} emptyLabel="No actions recorded." />
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "warning" }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${tone === "warning" ? "text-amber-700" : "text-foreground"}`}>{value}</div>
    </div>
  );
}

function OutcomeBreakdown({ breakdown }: { breakdown: Record<string, number> }) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-sm font-semibold">Latest outcome breakdown</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {Object.entries(breakdown).map(([label, count]) => (
          <Badge key={label} variant="secondary">{label}: {count}</Badge>
        ))}
      </div>
    </div>
  );
}

function SummaryList({ title, items, emptyLabel }: { title: string; items: string[]; emptyLabel: string }) {
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="border-b px-3 py-2 text-sm font-semibold">{title}</div>
      <div className="max-h-56 overflow-auto p-3 text-sm">
        {items.length ? (
          <ul className="space-y-2">
            {items.map((item, index) => <li key={`${item}-${index}`} className="break-words">{item}</li>)}
          </ul>
        ) : (
          <div className="text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function IssueList({ title, items, emptyLabel, tone = "warning" }: { title: string; items: string[]; emptyLabel: string; tone?: "warning" | "error" }) {
  return (
    <div className="rounded-md border border-border bg-background">
      <div className="border-b px-3 py-2 text-sm font-semibold">{title}</div>
      <div className="max-h-56 overflow-auto p-3 text-sm">
        {items.length ? (
          <ul className="space-y-2">
            {items.map((item, index) => (
              <li key={`${item}-${index}`} className={tone === "error" ? "text-red-700" : "text-amber-700"}>{item}</li>
            ))}
          </ul>
        ) : (
          <div className="text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <Alert className="border-red-500/30 bg-red-500/10">
      <AlertTriangle className="size-4 text-red-700" />
      <AlertTitle>Request failed</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function LoadingInline({ label }: { label: string }) {
  return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{label}</div>;
}

function EmptyInline({ label }: { label: string }) {
  return <div className="text-sm text-muted-foreground">{label}</div>;
}

function StatusBadge({ status }: { status: MigrationPreviewRow["mappingStatus"] }) {
  if (status === "willUpdate") return <Badge className="bg-emerald-600 text-white">Will update</Badge>;
  if (status === "willSkip") return <Badge variant="outline">Will skip</Badge>;
  if (status === "unmapped") return <Badge className="bg-amber-500 text-white">Unmapped</Badge>;
  if (status === "error") return <Badge variant="destructive">Error</Badge>;
  if (status === "warning") return <Badge variant="outline">Warning</Badge>;
  if (status === "willOverwrite") return <Badge className="bg-blue-600 text-white">Will overwrite</Badge>;
  return <Badge variant="secondary">Mapped</Badge>;
}

function filterPreviewRows(preview: MigrationPreview | null, filter: PreviewFilter) {
  if (!preview) return [];
  const rootPaths = new Set(preview.selectedRoots.map((root) => root.path));
  if (filter === "all") return preview.rows;
  if (filter === "roots") return preview.rows.filter((row) => rootPaths.has(row.sourceSuitePath));
  if (filter === "children") return preview.rows.filter((row) => !rootPaths.has(row.sourceSuitePath));
  if (filter === "mapped") return preview.rows.filter((row) => row.mappingStatus !== "unmapped" && row.mappingStatus !== "error");
  if (filter === "unmapped") return preview.rows.filter((row) => row.mappingStatus === "unmapped");
  if (filter === "willUpdate") return preview.rows.filter((row) => row.mappingStatus === "willUpdate");
  if (filter === "willSkip") return preview.rows.filter((row) => row.mappingStatus === "willSkip");
  if (filter === "willOverwrite") return preview.rows.filter((row) => row.mappingStatus === "willOverwrite");
  if (filter === "errors") return preview.rows.filter((row) => row.mappingStatus === "error");
  return preview.rows.filter((row) => row.warningOrError || row.mappingStatus === "warning");
}

function flattenTree(nodes: SuiteTreeNode[]): SuiteTreeNode[] {
  return nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
}

function formatSuiteType(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value?: string) {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatStatus(value: string) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
