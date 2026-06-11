"use client";

import type { LucideIcon } from "lucide-react";
import { Check, ChevronDown, ChevronRight, LockKeyhole } from "lucide-react";

import { cn } from "@/lib/utils";

export type WorkflowStepDefinition<StepId extends string> = {
  id: StepId;
  label: string;
  description?: string;
  icon?: LucideIcon;
};

export function WorkflowStepper<StepId extends string>({
  steps,
  activeStepId,
  completedStepIds = [],
  enabledStepIds = [],
  onStepChange,
  ariaLabel = "Workflow progress",
  className,
}: {
  steps: readonly WorkflowStepDefinition<StepId>[];
  activeStepId: StepId;
  completedStepIds?: readonly StepId[];
  enabledStepIds?: readonly StepId[];
  onStepChange?: (stepId: StepId) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const completed = new Set(completedStepIds);
  const enabled = new Set([activeStepId, ...enabledStepIds]);

  return (
    <nav
      aria-label={ariaLabel}
      className={cn("rounded-xl border border-border bg-muted/45 p-2 shadow-sm", className)}
    >
      <ol className="flex flex-col gap-10 md:gap-12 md:flex-row">
        {steps.map((step, index) => {
          const active = step.id === activeStepId;
          const done = completed.has(step.id);
          const canNavigate = enabled.has(step.id);
          const StepIcon = step.icon;
          const content = (
            <>
              <span
                className={cn(
                  "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-bold transition-colors",
                  active && "border-primary bg-primary text-primary-foreground shadow-sm",
                  done && !active && "border-success bg-success text-success-foreground",
                  !active && !done && canNavigate && "border-border bg-card text-foreground",
                  !active && !done && !canNavigate && "border-border bg-muted text-muted-foreground",
                )}
              >
                {done && !active ? (
                  <Check className="size-4" aria-hidden="true" />
                ) : !canNavigate ? (
                  <LockKeyhole className="size-3.5" aria-hidden="true" />
                ) : StepIcon ? (
                  <StepIcon className="size-4" aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="min-w-0 text-left">
                <span
                  className={cn(
                    "block text-sm font-semibold leading-5",
                    active && "text-primary",
                    done && !active && "text-success",
                    !active && !done && "text-foreground",
                    !canNavigate && "text-muted-foreground",
                  )}
                >
                  <span className="mr-1 text-xs font-medium opacity-70">Step {index + 1}</span>
                  {step.label}
                </span>
                {step.description ? (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {step.description}
                  </span>
                ) : null}
              </span>
            </>
          );
          const itemClassName = cn(
            "relative flex min-h-[76px] w-full items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors",
            active && "border-primary bg-card shadow-sm ring-1 ring-primary/15",
            done && !active && "border-success/35 bg-success/10",
            !active && !done && canNavigate && "border-border bg-card hover:bg-accent/60",
            !active && !done && !canNavigate && "border-transparent bg-transparent",
          );

          return (
            <li key={step.id} className="relative min-w-0 flex-1">
              {onStepChange ? (
                <button
                  type="button"
                  className={itemClassName}
                  disabled={!canNavigate}
                  aria-current={active ? "step" : undefined}
                  aria-label={`${step.label}${done ? ", completed" : active ? ", current step" : !canNavigate ? ", locked" : ""}`}
                  onClick={() => onStepChange(step.id)}
                >
                  {content}
                </button>
              ) : (
                <div className={itemClassName} aria-current={active ? "step" : undefined}>
                  {content}
                </div>
              )}
              {index < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none absolute left-1/2 top-[calc(100%+1.25rem)] z-20 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background shadow-sm md:left-[calc(100%+1.5rem)] md:top-1/2",
                    done
                      ? "border-success/35 text-success"
                      : "border-border text-muted-foreground",
                  )}
                >
                  <ChevronDown className="size-4 md:hidden" />
                  <ChevronRight className="hidden size-4 md:block" />
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
