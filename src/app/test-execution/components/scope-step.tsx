"use client";

import { useState } from "react";
import { ChevronDown, Download, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorBanner } from "@/components/workflow/error-banner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NaturalStep } from "@/modules/test-execution/action-schema";

import type { DraftCase } from "../lib/draft-storage";
import { azureStepsToNaturalPlan } from "../lib/manual-step-form";
import { TextStepEditor } from "./text-step-editor";

/**
 * Test Scope step: pick test cases from a user story's linked cases OR from a
 * Test Plan/Suite, or write manual cases. Imported steps are used as written
 * (run-local editable copy — the Azure source is never modified); the AI
 * executes them at run time, so no compilation and no locators.
 */

export type ImportableTestCase = {
  id: string;
  azureTestCaseId?: string;
  title: string;
  steps: { action: string; expectedResult: string }[];
};

export type TestPlanOption = { id: string; name: string };
export type TestSuiteOption = { id: string; name: string; path?: string };

export function ScopeStep({
  story,
  onStoryChange,
  onLoadLinkedCases,
  linkedCases,
  linkedLoading,
  linkedError,
  planSuite,
  cases,
  onCasesChange,
  onAddImportedCase,
  onAddImportedCases,
  onRemoveImportedCases,
  availableCredentialTitles,
  onContinue,
  onBack,
}: {
  story: { workItemId: string; title: string };
  onStoryChange: (story: { workItemId: string; title: string }) => void;
  onLoadLinkedCases: () => Promise<void>;
  linkedCases: ImportableTestCase[] | null;
  linkedLoading: boolean;
  linkedError: string | null;
  planSuite: {
    plans: TestPlanOption[];
    plansLoading: boolean;
    selectedPlanId: string;
    onSelectPlan: (planId: string) => void;
    suites: TestSuiteOption[];
    suitesLoading: boolean;
    selectedSuiteId: string;
    onSelectSuite: (suiteId: string) => void;
    onLoadSuiteCases: () => Promise<void>;
    suiteCases: ImportableTestCase[] | null;
    suiteCasesLoading: boolean;
    error: string | null;
  };
  cases: DraftCase[];
  onCasesChange: (cases: DraftCase[]) => void;
  onAddImportedCase: (testCase: ImportableTestCase) => void;
  onAddImportedCases: (testCases: ImportableTestCase[]) => void;
  onRemoveImportedCases: (testCases: ImportableTestCase[]) => void;
  availableCredentialTitles: string[];
  onContinue: () => void;
  onBack: () => void;
}) {
  const [expandedCase, setExpandedCase] = useState<number | null>(null);

  const importedIds = new Set(cases.filter((c) => c.azureTestCaseId).map((c) => c.azureTestCaseId));

  const addManualCase = () => {
    onCasesChange([
      ...cases,
      {
        title: `Manual case ${cases.length + 1}`,
        sourceKind: "manual",
        azureTestCaseId: null,
        plan: { schemaVersion: "v2-natural", steps: [{ instruction: "", expectedResult: "" }] },
      },
    ]);
    setExpandedCase(cases.length);
  };

  const updateCase = (index: number, patch: Partial<DraftCase>) => {
    onCasesChange(cases.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  };

  const caseReady = (entry: DraftCase) =>
    entry.plan.steps.length > 0 && entry.plan.steps.every((step) => step.instruction.trim().length > 0);
  const readyCount = cases.filter(caseReady).length;

  const renderImportList = (list: ImportableTestCase[]) => {
    // "Importable" must match EXACTLY what the add handler accepts
    // (azureStepsToNaturalPlan drops blank-only steps), or the Add all
    // counter can never reach zero and the toggle deadlocks.
    const importable = list.filter((testCase) => azureStepsToNaturalPlan(testCase.steps) !== null);
    const remaining = importable.filter(
      (testCase) => !importedIds.has(testCase.azureTestCaseId ?? testCase.id),
    );
    const allAdded = importable.length > 0 && remaining.length === 0;
    return (
      <div className="space-y-1.5">
        {importable.length > 0 ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => (allAdded ? onRemoveImportedCases(importable) : onAddImportedCases(remaining))}
            >
              {allAdded ? (
                <><Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden /> Remove all ({importable.length})</>
              ) : (
                <><Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add all ({remaining.length})</>
              )}
            </Button>
          </div>
        ) : null}
        <ul className="space-y-1.5">
          {list.map((testCase) => {
            const azureId = testCase.azureTestCaseId ?? testCase.id;
            const imported = importedIds.has(azureId);
            const addable = azureStepsToNaturalPlan(testCase.steps) !== null;
            return (
              <li key={azureId} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">#{azureId}</span>
                  {testCase.title}
                  <span className="ml-2 text-xs text-muted-foreground">{testCase.steps.length} step(s)</span>
                </span>
                <Button
                  size="sm"
                  variant={imported ? "ghost" : "outline"}
                  disabled={imported || !addable}
                  onClick={() => onAddImportedCase(testCase)}
                >
                  {imported ? "Added" : <><Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add</>}
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Import from a user story</CardTitle>
          <CardDescription>
            Load the story&apos;s linked test cases. Their written steps are used as-is — the AI performs them in the browser. The Azure test case itself is never changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="te-story-id">User Story ID</Label>
              <Input
                id="te-story-id"
                className="w-40"
                inputMode="numeric"
                placeholder="e.g. 12345"
                value={story.workItemId}
                onChange={(event) => onStoryChange({ ...story, workItemId: event.target.value.replace(/\D/g, "") })}
              />
            </div>
            <Button variant="outline" disabled={!story.workItemId || linkedLoading} onClick={() => void onLoadLinkedCases()}>
              {linkedLoading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-1 h-4 w-4" aria-hidden />}
              Load linked test cases
            </Button>
          </div>

          {linkedError ? <ErrorBanner title="Could not load linked test cases" message={linkedError} /> : null}
          {linkedCases !== null && linkedCases.length === 0 && !linkedLoading ? (
            <p className="text-sm text-muted-foreground">
              This story has no linked test cases. Import from a Test Plan below, or add manual cases.
            </p>
          ) : null}
          {linkedCases && linkedCases.length > 0 ? renderImportList(linkedCases) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Import from a Test Plan / Suite</CardTitle>
          <CardDescription>Pick a plan and suite, then add its test cases to this run.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="te-plan-select">Test Plan</Label>
              <Select
                value={planSuite.selectedPlanId || undefined}
                onValueChange={planSuite.onSelectPlan}
                disabled={planSuite.plansLoading}
              >
                <SelectTrigger id="te-plan-select">
                  <SelectValue placeholder={planSuite.plansLoading ? "Loading plans…" : "Select a test plan"} />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {planSuite.plans.map((plan) => (
                    <SelectItem key={plan.id} value={plan.id}>
                      {plan.id} — {plan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="te-suite-select">Test Suite</Label>
              <Select
                value={planSuite.selectedSuiteId || undefined}
                onValueChange={planSuite.onSelectSuite}
                disabled={!planSuite.selectedPlanId || planSuite.suitesLoading}
              >
                <SelectTrigger id="te-suite-select">
                  <SelectValue
                    placeholder={
                      !planSuite.selectedPlanId
                        ? "Select a plan first"
                        : planSuite.suitesLoading
                          ? "Loading suites…"
                          : "Select a suite"
                    }
                  />
                </SelectTrigger>
                <SelectContent className="max-h-64">
                  {planSuite.suites.map((suite) => (
                    <SelectItem key={suite.id} value={suite.id}>
                      {suite.path ?? suite.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            variant="outline"
            disabled={!planSuite.selectedSuiteId || planSuite.suiteCasesLoading}
            onClick={() => void planSuite.onLoadSuiteCases()}
          >
            {planSuite.suiteCasesLoading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Download className="mr-1 h-4 w-4" aria-hidden />
            )}
            Load test cases
          </Button>

          {planSuite.error ? <ErrorBanner title="Test Plans are unavailable" message={planSuite.error} /> : null}
          {planSuite.suiteCases !== null && planSuite.suiteCases.length === 0 && !planSuite.suiteCasesLoading ? (
            <p className="text-sm text-muted-foreground">This suite has no test cases.</p>
          ) : null}
          {planSuite.suiteCases && planSuite.suiteCases.length > 0 ? renderImportList(planSuite.suiteCases) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Selected test cases ({cases.length})</CardTitle>
          <CardDescription>
            Cases run top to bottom in one browser session. Steps are plain language — edit them freely; the copies here never change the Azure source.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {cases.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing selected yet — import cases above or add a manual case.</p>
          ) : (
            cases.map((entry, index) => {
              const expanded = expandedCase === index;
              return (
                <div key={index} className="rounded-md border">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      aria-expanded={expanded}
                      onClick={() => setExpandedCase(expanded ? null : index)}
                    >
                      <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`} aria-hidden />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {index + 1}. {entry.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {entry.plan.steps.length} step(s)
                      </span>
                      {entry.sourceKind === "azure_test_case" ? (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">Azure #{entry.azureTestCaseId}</span>
                      ) : null}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      aria-label={`Remove case ${entry.title}`}
                      onClick={() => onCasesChange(cases.filter((_, i) => i !== index))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {expanded ? (
                    <div className="space-y-3 border-t px-3 py-3">
                      <div className="space-y-1.5">
                        <Label htmlFor={`te-case-title-${index}`}>Case title</Label>
                        <Input
                          id={`te-case-title-${index}`}
                          value={entry.title}
                          onChange={(event) => updateCase(index, { title: event.target.value })}
                        />
                      </div>
                      <TextStepEditor
                        steps={entry.plan.steps as NaturalStep[]}
                        onChange={(steps) => updateCase(index, { plan: { ...entry.plan, steps } })}
                        availableCredentialTitles={availableCredentialTitles}
                        idPrefix={`te-case-${index}`}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          <Button variant="outline" size="sm" onClick={addManualCase}>
            <Plus className="mr-1 h-4 w-4" /> Add manual case
          </Button>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button disabled={readyCount === 0 || readyCount !== cases.length} onClick={onContinue}>
          Continue to Review & Execute
        </Button>
      </div>
    </div>
  );
}
