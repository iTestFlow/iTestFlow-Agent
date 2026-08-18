"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusChip } from "@/components/qa/status-chip";
import { ConfirmationDialog } from "@/components/qa/confirmation-dialog";
import { cn } from "@/lib/utils";
import { caseIsReady, newDraftStep, newManualCase, type DraftCase, type DraftStep } from "../lib/execution-draft";

const SOURCE_LABELS: Record<DraftCase["source"], string> = {
  "plan-suite": "Test Plan",
  "user-story": "User Story",
  manual: "Manual",
};

/**
 * The editable working set: every case — imported or hand-written — can have
 * its title and steps changed freely. Edits never touch the Azure source.
 */
export function WorkingSetEditor({
  cases,
  onChange,
}: {
  cases: DraftCase[];
  onChange: (cases: DraftCase[]) => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  function updateCase(localId: string, patch: Partial<DraftCase>) {
    onChange(cases.map((testCase) => (testCase.localId === localId ? { ...testCase, ...patch } : testCase)));
  }

  function updateStep(caseId: string, stepId: string, patch: Partial<DraftStep>) {
    onChange(cases.map((testCase) => testCase.localId === caseId
      ? { ...testCase, steps: testCase.steps.map((step) => (step.localId === stepId ? { ...step, ...patch } : step)) }
      : testCase));
  }

  function moveStep(caseId: string, index: number, direction: -1 | 1) {
    onChange(cases.map((testCase) => {
      if (testCase.localId !== caseId) return testCase;
      const target = index + direction;
      if (target < 0 || target >= testCase.steps.length) return testCase;
      const steps = [...testCase.steps];
      [steps[index], steps[target]] = [steps[target], steps[index]];
      return { ...testCase, steps };
    }));
  }

  function addManualCase() {
    const added = newManualCase(cases.length);
    setExpanded((current) => ({ ...current, [added.localId]: true }));
    onChange([...cases, added]);
  }

  return (
    <div className="space-y-3">
      {!cases.length ? (
        <div className="content-empty-state">
          <p className="text-sm text-muted-foreground">
            No test cases yet. Import them above, or write your own from scratch.
          </p>
        </div>
      ) : null}
      {cases.map((testCase) => {
        const isOpen = expanded[testCase.localId] ?? false;
        const ready = caseIsReady(testCase);
        return (
          <div key={testCase.localId} className="rounded-lg border border-border">
            <div className="flex flex-wrap items-center gap-2 p-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={isOpen}
                onClick={() => setExpanded((current) => ({ ...current, [testCase.localId]: !isOpen }))}
              >
                <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
                <span className="min-w-0 truncate text-sm font-medium">{testCase.title.trim() || "Untitled test case"}</span>
              </button>
              <Badge variant="outline">{SOURCE_LABELS[testCase.source]}</Badge>
              {testCase.azureTestCaseId ? <span className="font-mono text-xs text-muted-foreground">#{testCase.azureTestCaseId}</span> : null}
              <StatusChip tone={ready ? "success" : "warning"}>{ready ? "Ready" : "Needs steps"}</StatusChip>
              <ConfirmationDialog
                trigger={
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${testCase.title.trim() || "test case"}`}>
                    <Trash2 className="size-4 text-destructive" aria-hidden="true" />
                  </Button>
                }
                title="Remove this test case?"
                description={`"${testCase.title.trim() || "Untitled test case"}" and its steps will be removed from this run. The original in Azure DevOps is not affected.`}
                confirmLabel="Remove"
                onConfirm={() => onChange(cases.filter((entry) => entry.localId !== testCase.localId))}
              />
            </div>
            {isOpen ? (
              <div className="space-y-3 border-t border-border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor={`case-title-${testCase.localId}`}>Case title</Label>
                  <Input
                    id={`case-title-${testCase.localId}`}
                    value={testCase.title}
                    maxLength={400}
                    onChange={(event) => updateCase(testCase.localId, { title: event.target.value })}
                  />
                </div>
                <ol className="space-y-2">
                  {testCase.steps.map((step, index) => (
                    <li key={step.localId} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex items-start gap-2">
                        <span className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold tabular-nums text-primary">{index + 1}</span>
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`step-action-${step.localId}`}>Step</Label>
                            <Textarea
                              id={`step-action-${step.localId}`}
                              rows={2}
                              value={step.action}
                              maxLength={4000}
                              placeholder="What should happen — e.g. Enter the Username and the Password, then select Sign in"
                              onChange={(event) => updateStep(testCase.localId, step.localId, { action: event.target.value })}
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`step-expected-${step.localId}`}>Expected result (optional — screenshots use this as a checkpoint)</Label>
                            <Input
                              id={`step-expected-${step.localId}`}
                              value={step.expectedResult}
                              maxLength={4000}
                              placeholder="e.g. The dashboard shows the signed-in user's name"
                              onChange={(event) => updateStep(testCase.localId, step.localId, { expectedResult: event.target.value })}
                            />
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-col gap-1">
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move step ${index + 1} up`} disabled={index === 0}
                            onClick={() => moveStep(testCase.localId, index, -1)}>
                            <ArrowUp className="size-3.5" aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move step ${index + 1} down`} disabled={index === testCase.steps.length - 1}
                            onClick={() => moveStep(testCase.localId, index, 1)}>
                            <ArrowDown className="size-3.5" aria-hidden="true" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove step ${index + 1}`} disabled={testCase.steps.length === 1}
                            onClick={() => updateCase(testCase.localId, { steps: testCase.steps.filter((entry) => entry.localId !== step.localId) })}>
                            <Trash2 className="size-3.5 text-destructive" aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => updateCase(testCase.localId, { steps: [...testCase.steps, newDraftStep()] })}
                >
                  <Plus className="size-4" aria-hidden="true" />
                  Add step
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
      <Button type="button" variant="outline" onClick={addManualCase}>
        <Plus className="size-4" aria-hidden="true" />
        Add manual test case
      </Button>
    </div>
  );
}
