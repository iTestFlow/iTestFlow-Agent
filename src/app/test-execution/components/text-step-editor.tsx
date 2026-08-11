"use client";

import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  TEST_EXECUTION_LAYER_HINTS,
  type LayerHint,
  type NaturalStep,
} from "@/modules/test-execution/action-schema";

import { emptyNaturalStep, validateNaturalStep } from "../lib/manual-step-form";

/**
 * Text-step editor: the whole authoring surface is an instruction plus an
 * expected result per step — the AI locates elements and acts at run time.
 * Fully keyboard-operable: reorder is buttons, never drag-only.
 */

export function TextStepEditor({
  steps,
  onChange,
  availableCredentialTitles,
  idPrefix,
  showLayerHint = true,
}: {
  steps: NaturalStep[];
  onChange: (steps: NaturalStep[]) => void;
  /** Friendly credential labels the AI can use ("Default password", "Admin API key"). */
  availableCredentialTitles: string[];
  idPrefix: string;
  /** Login plans are browser setup and deliberately hide the multi-layer hint. */
  showLayerHint?: boolean;
}) {
  const update = (index: number, patch: Partial<NaturalStep>) =>
    onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="space-y-3">
      {steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No steps yet. Write each step the way you would for a manual tester — the agent chooses among the configured layers.
        </p>
      ) : (
        <ol className="space-y-3">
          {steps.map((step, index) => {
            const error = step.instruction.length > 0 ? validateNaturalStep(step) : null;
            return (
              <li key={`${idPrefix}-step-${index}`} className="rounded-md border bg-card p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 w-6 shrink-0 text-right text-sm font-medium text-muted-foreground tabular-nums">
                    {index + 1}.
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="space-y-1">
                      <Label htmlFor={`${idPrefix}-instruction-${index}`}>Step</Label>
                      <Textarea
                        id={`${idPrefix}-instruction-${index}`}
                        rows={2}
                        placeholder='e.g. "Open the Categories page and select Electronics"'
                        value={step.instruction}
                        onChange={(event) => update(index, { instruction: event.target.value })}
                      />
                    </div>
                    <div className={`grid gap-2 ${showLayerHint ? "sm:grid-cols-[minmax(0,1fr)_11rem]" : ""}`}>
                      <div className="space-y-1">
                        <Label htmlFor={`${idPrefix}-expected-${index}`}>Expected result</Label>
                        <Input
                          id={`${idPrefix}-expected-${index}`}
                          placeholder="What should be true afterwards? (optional)"
                          value={step.expectedResult}
                          onChange={(event) => update(index, { expectedResult: event.target.value })}
                        />
                      </div>
                      {showLayerHint ? (
                        <div className="space-y-1">
                          <Label htmlFor={`${idPrefix}-layer-${index}`}>Execution layer</Label>
                          <Select
                            value={step.layerHint ?? "auto"}
                            onValueChange={(value) => update(index, { layerHint: value as LayerHint })}
                          >
                            <SelectTrigger id={`${idPrefix}-layer-${index}`} aria-describedby={`${idPrefix}-layer-help`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TEST_EXECUTION_LAYER_HINTS.map((hint) => (
                                <SelectItem key={hint} value={hint}>{layerHintLabel(hint)}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : null}
                    </div>
                    {error ? (
                      <p className="text-xs text-destructive" role="alert">
                        {error}
                      </p>
                    ) : null}
                  </div>
                  <span className="flex shrink-0 flex-col gap-0.5">
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move step ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Move step ${index + 1} down`} disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label={`Remove step ${index + 1}`} onClick={() => onChange(steps.filter((_, i) => i !== index))}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {availableCredentialTitles.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          The AI knows these credentials: {availableCredentialTitles.map((title, index) => (
            <span key={`${title}-${index}`}>
              {index > 0 ? ", " : ""}
              <span className="rounded bg-muted px-1 font-medium">{title}</span>
            </span>
          ))}
          . Just mention one in a step — e.g. &quot;Enter the default password&quot;. Values stay encrypted and are never
          shown to the AI or in reports.
        </p>
      ) : null}

      {showLayerHint ? (
        <p id={`${idPrefix}-layer-help`} className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="outline">Auto</Badge> lets the agent choose and switch layers. Choose UI, API, or DB to restrict a
          step; Mixed requires evidence from more than one configured layer.
        </p>
      ) : null}

      <Button size="sm" variant="outline" onClick={() => onChange([...steps, emptyNaturalStep()])}>
        <Plus className="mr-1 h-4 w-4" /> Add step
      </Button>
    </div>
  );
}

function layerHintLabel(hint: LayerHint): string {
  return hint === "auto" ? "Auto" : hint === "db" ? "Database" : hint === "mixed" ? "Mixed" : hint.toUpperCase();
}
