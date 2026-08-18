"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableCombobox, type SearchableComboboxOption } from "@/components/ui/searchable-combobox";
import { Callout } from "@/components/qa/callout";
import { EmptyBlock, SectionCard } from "@/components/workflow/test-intelligence-shared";
import { WORK_ITEM_ID_PLACEHOLDER, WorkItemPreview } from "@/components/workflow/work-item-loader";
import { postJson } from "@/components/workflow/post-json";
import { caughtErrorMessage } from "@/shared/lib/api-error-message";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { isCaseAlreadyImported, type DraftCase, type ImportedCase } from "../lib/execution-draft";

type Option = { id: string; name: string; path?: string };

type PreviewCase = {
  testCaseId: number;
  testPointId: number;
  planId: number;
  suiteId: number;
  title: string;
  steps: Array<{ action: string; expectedResult?: string | null }>;
};

type LinkedCase = {
  id: string;
  azureTestCaseId?: string;
  title: string;
  steps: Array<{ action: string; expectedResult?: string | null }>;
};

function ImportList({
  items,
  existingCases,
  onAdd,
}: {
  items: ImportedCase[];
  existingCases: DraftCase[];
  onAdd: (cases: ImportedCase[]) => void;
}) {
  const remaining = items.filter((item) => !isCaseAlreadyImported(existingCases, item));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{items.length} test case{items.length === 1 ? "" : "s"} found.</p>
        <Button type="button" variant="outline" size="sm" disabled={!remaining.length} onClick={() => onAdd(remaining)}>
          <Plus className="size-4" aria-hidden="true" />
          Add all ({remaining.length})
        </Button>
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((item, index) => {
          const added = isCaseAlreadyImported(existingCases, item);
          return (
            <li key={`${item.azureTestCaseId ?? "case"}-${item.azureTestPointId ?? index}`} className="flex items-center gap-3 p-3">
              {item.azureTestCaseId ? <span className="font-mono text-xs text-primary">#{item.azureTestCaseId}</span> : null}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">{item.steps.length} step{item.steps.length === 1 ? "" : "s"}</p>
              </div>
              <Button type="button" variant="outline" size="sm" disabled={added} onClick={() => onAdd([item])}>
                {added ? "Added" : "Add"}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Step 2's import sources: an Azure Test Plan/Suite preview and a User Story
 * lookup. Both feed the same editable working set; failures surface as
 * passive banners (no auto-retry), matching the app's other workflows.
 */
export function CaseImportPanel({
  scope,
  providerId,
  existingCases,
  onAddCases,
}: {
  scope: ActiveProjectScope | null;
  providerId: string | null;
  existingCases: DraftCase[];
  onAddCases: (cases: ImportedCase[], provenance?: { planId: number; suiteId: number }) => void;
}) {
  const [plans, setPlans] = useState<Option[]>([]);
  const [suites, setSuites] = useState<Option[]>([]);
  const [planId, setPlanId] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [plansLoading, setPlansLoading] = useState(false);
  const [suitesLoading, setSuitesLoading] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewCases, setPreviewCases] = useState<ImportedCase[] | null>(null);
  const [previewProvenance, setPreviewProvenance] = useState<{ planId: number; suiteId: number } | null>(null);

  const [storyId, setStoryId] = useState("");
  const [storyLoading, setStoryLoading] = useState(false);
  const [storyError, setStoryError] = useState<string | null>(null);
  const [storyCases, setStoryCases] = useState<ImportedCase[] | null>(null);

  const plansRequestedRef = useRef<string | null>(null);
  const isJira = providerId === "jira-cloud";

  useEffect(() => {
    if (!scope || isJira || plansRequestedRef.current === scope.projectId) return;
    plansRequestedRef.current = scope.projectId;
    setPlans([]); setPlanId(""); setSuites([]); setSuiteId(""); setPlanError(null);
    setPreviewCases(null); setStoryCases(null);
    setPlansLoading(true);
    void postJson<{ testPlans: Option[] }>("/api/azure-devops/test-plans", { scope })
      .then((data) => setPlans(data.testPlans))
      .catch((error) => setPlanError(caughtErrorMessage(error, "Test Plans could not be loaded.")))
      .finally(() => setPlansLoading(false));
  }, [scope, isJira]);

  useEffect(() => {
    if (!scope || !planId) { setSuites([]); setSuiteId(""); return; }
    setSuitesLoading(true);
    setSuiteId("");
    void postJson<{ testSuites: Option[] }>("/api/azure-devops/test-suites", { scope, testPlanId: planId })
      .then((data) => setSuites(data.testSuites))
      .catch((error) => setPlanError(caughtErrorMessage(error, "Test Suites could not be loaded.")))
      .finally(() => setSuitesLoading(false));
  }, [scope, planId]);

  const loadPreview = useCallback(async () => {
    if (!scope || !planId || !suiteId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewCases(null);
    try {
      const data = await postJson<{ cases: PreviewCase[] }>("/api/test-execution/playwright/case-preview", {
        scope, testPlanId: Number(planId), testSuiteId: Number(suiteId),
      });
      setPreviewCases(data.cases.map((entry) => ({
        azureTestCaseId: entry.testCaseId,
        azureTestPointId: entry.testPointId,
        azurePlanId: entry.planId,
        azureSuiteId: entry.suiteId,
        title: entry.title,
        steps: entry.steps,
        source: "plan-suite" as const,
      })));
      setPreviewProvenance({ planId: Number(planId), suiteId: Number(suiteId) });
    } catch (error) {
      setPreviewError(caughtErrorMessage(error, "Test cases could not be loaded from the selected plan and suite."));
    } finally {
      setPreviewLoading(false);
    }
  }, [scope, planId, suiteId]);

  const loadStoryCases = useCallback(async () => {
    if (!scope || !/^\d+$/.test(storyId.trim())) return;
    setStoryLoading(true);
    setStoryError(null);
    setStoryCases(null);
    try {
      const data = await postJson<{ linkedTestCases: LinkedCase[] }>("/api/azure-devops/linked-test-cases", {
        scope, userStoryId: storyId.trim(),
      });
      if (!data.linkedTestCases.length) {
        setStoryError("No linked test cases were found for this user story.");
        return;
      }
      setStoryCases(data.linkedTestCases.map((entry) => ({
        azureTestCaseId: Number(entry.azureTestCaseId ?? entry.id) || undefined,
        title: entry.title,
        steps: entry.steps,
        source: "user-story" as const,
      })));
    } catch (error) {
      setStoryError(caughtErrorMessage(error, "Linked test cases could not be loaded."));
    } finally {
      setStoryLoading(false);
    }
  }, [scope, storyId]);

  if (isJira) {
    return (
      <SectionCard title="Add test cases" description="Import from your test management tool, or write cases by hand.">
        <div className="p-4">
          <EmptyBlock message="Importing test cases isn't available yet for Jira workspaces. You can still write test cases manually below." />
        </div>
      </SectionCard>
    );
  }

  const planOptions: SearchableComboboxOption[] = plans.map((plan) => ({ value: plan.id, label: plan.name }));
  const suiteOptions: SearchableComboboxOption[] = suites.map((suite) => ({ value: suite.id, label: suite.path ?? suite.name }));

  function addCases(cases: ImportedCase[], provenance?: { planId: number; suiteId: number } | null) {
    onAddCases(cases, provenance ?? undefined);
    toast.success(`Added ${cases.length} test case${cases.length === 1 ? "" : "s"}.`);
  }

  return (
    <SectionCard title="Add test cases" description="Import from a Test Plan or a User Story — imported copies are yours to edit and never change the Azure source.">
      <div className="space-y-5 p-4">
        <div className="space-y-3">
          <p className="text-sm font-medium">From a Test Plan / Suite</p>
          {planError ? <Callout tone="error" role="alert">{planError}</Callout> : null}
          <div className="grid items-end gap-3 lg:grid-cols-[240px_280px_auto]">
            <div className="space-y-1.5">
              <Label>Test Plan</Label>
              <SearchableCombobox
                value={planId}
                options={planOptions}
                onValueChange={setPlanId}
                loading={plansLoading}
                placeholder="Select a Test Plan"
                emptyMessage="No Test Plans found."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Test Suite</Label>
              <SearchableCombobox
                value={suiteId}
                options={suiteOptions}
                onValueChange={setSuiteId}
                loading={suitesLoading}
                disabled={!planId}
                placeholder="Select a Test Suite"
                emptyMessage="No Test Suites found."
              />
            </div>
            <Button type="button" variant="outline" disabled={!planId || !suiteId || previewLoading} onClick={() => void loadPreview()}>
              {previewLoading ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
              Load test cases
            </Button>
          </div>
          {previewError ? <Callout tone="error" role="alert">{previewError}</Callout> : null}
          {previewCases ? <ImportList items={previewCases} existingCases={existingCases} onAdd={(cases) => addCases(cases, previewProvenance)} /> : null}
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-sm font-medium">From a User Story</p>
          <div className="grid items-end gap-3 lg:grid-cols-[240px_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="test-execution-story-id">User Story ID</Label>
              <Input
                id="test-execution-story-id"
                inputMode="numeric"
                maxLength={10}
                placeholder={WORK_ITEM_ID_PLACEHOLDER}
                value={storyId}
                onChange={(event) => { setStoryId(event.target.value); setStoryCases(null); setStoryError(null); }}
              />
            </div>
            <Button type="button" variant="outline" disabled={!/^\d+$/.test(storyId.trim()) || storyLoading} onClick={() => void loadStoryCases()}>
              {storyLoading ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
              Load linked test cases
            </Button>
          </div>
          <WorkItemPreview scope={scope} workItemId={storyId} emptyText="Enter a user story ID to load its details here." />
          {storyError ? <Callout tone="error" role="alert">{storyError}</Callout> : null}
          {storyCases ? <ImportList items={storyCases} existingCases={existingCases} onAdd={(cases) => addCases(cases)} /> : null}
        </div>
      </div>
    </SectionCard>
  );
}
