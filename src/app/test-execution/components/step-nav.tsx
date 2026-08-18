"use client";

import { ArrowLeft, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EXECUTION_STEPS, stepNavTargets, type ExecutionStepId } from "../lib/stepper-gating";

function stepLabel(id: ExecutionStepId): string {
  return EXECUTION_STEPS.find((step) => step.id === id)?.label ?? id;
}

/**
 * Bottom-of-step navigation so moving forward never depends on the stepper
 * pills alone. Next mirrors the stepper's gating; when blocked it stays
 * visible with the first blocking reason next to it.
 */
export function StepNav({
  activeStep,
  enabledStepIds,
  onNavigate,
  nextBlockedReason,
}: {
  activeStep: ExecutionStepId;
  enabledStepIds: ExecutionStepId[];
  onNavigate: (step: ExecutionStepId) => void;
  nextBlockedReason?: string;
}) {
  const { backTarget, nextTarget, nextEnabled } = stepNavTargets(activeStep, enabledStepIds);
  if (!backTarget && !nextTarget) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {backTarget ? (
        <Button type="button" variant="outline" onClick={() => onNavigate(backTarget)}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back: {stepLabel(backTarget)}
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
      {nextTarget ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {!nextEnabled ? (
            <span className="text-xs text-muted-foreground">{nextBlockedReason || "Complete this step to continue."}</span>
          ) : null}
          <Button type="button" disabled={!nextEnabled} onClick={() => onNavigate(nextTarget)}>
            Next: {stepLabel(nextTarget)}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
