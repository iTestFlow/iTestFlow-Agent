"use client";

import type { LucideIcon } from "lucide-react";
import { Check, ChevronDown, ChevronRight, LockKeyhole } from "lucide-react";

import { cn } from "@/lib/utils";

export type WorkflowStepDefinition<StepId extends string> = {
  id: StepId;
  label: string;
  /** Shorter label substituted on small screens when provided. */
  shortLabel?: string;
  /**
   * Helper text for the step. Surfaced via tooltip + screen-reader text by
   * default; rendered inline only when `showDescriptions` is enabled.
   */
  description?: string;
  /** Kept for callers; not rendered in the compact variant (numbers/checks are used instead). */
  icon?: LucideIcon;
};

/**
 * Compact, pill-based workflow stepper. Renders a single low-profile row
 * (~44px tall on desktop) whose only job is workflow navigation/status —
 * page-specific context (cards, Back buttons, elapsed time, tokens, metadata)
 * lives outside this component.
 *
 * State is derived from the same inputs every workflow client already passes:
 * `activeStepId` (current), `completedStepIds` (done), and `enabledStepIds`
 * (clickable); anything not enabled renders disabled/locked. When `onStepChange`
 * is omitted the steps render as a non-interactive status indicator.
 */
export function WorkflowStepper<StepId extends string>({
  steps,
  activeStepId,
  completedStepIds = [],
  enabledStepIds = [],
  onStepChange,
  ariaLabel = "Workflow progress",
  className,
  size = "compact",
  showDescriptions = false,
  orientation = "horizontal",
}: {
  steps: readonly WorkflowStepDefinition<StepId>[];
  activeStepId: StepId;
  completedStepIds?: readonly StepId[];
  enabledStepIds?: readonly StepId[];
  onStepChange?: (stepId: StepId) => void;
  ariaLabel?: string;
  className?: string;
  /** Visual density. `compact` (default) is the low-profile row; `default` adds a little breathing room. */
  size?: "compact" | "default";
  /** Render the step description as a second line inside the pill. Off by default to keep the row compact. */
  showDescriptions?: boolean;
  /** Lay the steps out in a row (default) or a stacked column. */
  orientation?: "horizontal" | "vertical";
}) {
  const completed = new Set(completedStepIds);
  const enabled = new Set([activeStepId, ...enabledStepIds]);
  const vertical = orientation === "vertical";
  const dense = size === "compact";

  return (
    <nav aria-label={ariaLabel} className={cn("w-full", className)}>
      <ol
        className={cn(
          "flex items-stretch gap-1.5",
          vertical ? "flex-col items-stretch" : "flex-wrap items-center",
        )}
      >
        {steps.map((step, index) => {
          const active = step.id === activeStepId;
          const done = completed.has(step.id) && !active;
          const canNavigate = enabled.has(step.id);
          const clickable = Boolean(onStepChange) && canNavigate;
          const isLast = index === steps.length - 1;

          const stateLabel = done
            ? "completed"
            : active
              ? "current step"
              : canNavigate
                ? "upcoming"
                : "locked";

          const badge = (
            <span
              className={cn(
                "flex shrink-0 items-center justify-center rounded-full border font-bold leading-none transition-colors",
                dense ? "size-5 text-[0.7rem]" : "size-6 text-xs",
                active && "border-primary bg-primary text-primary-foreground",
                done && "border-success bg-success text-success-foreground",
                !active && !done && canNavigate && "border-border bg-background text-foreground",
                !active && !done && !canNavigate && "border-border bg-muted text-muted-foreground",
              )}
            >
              {done ? (
                <Check className={dense ? "size-3" : "size-3.5"} aria-hidden="true" />
              ) : !canNavigate ? (
                <LockKeyhole className={dense ? "size-3" : "size-3.5"} aria-hidden="true" />
              ) : (
                index + 1
              )}
            </span>
          );

          const pillClassName = cn(
            "group inline-flex min-w-0 max-w-full items-center gap-2 border text-left align-middle font-medium outline-none transition-colors",
            "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            showDescriptions ? "rounded-lg" : "rounded-full",
            dense ? "px-3 py-1.5 text-sm" : "px-3.5 py-2 text-sm",
            active && "border-primary bg-primary/10 text-primary ring-1 ring-primary/15",
            done && "border-success/40 bg-success/10 text-success",
            !active && !done && canNavigate && "border-border bg-card text-foreground",
            !active && !done && !canNavigate && "border-border/70 bg-muted/40 text-muted-foreground",
            clickable && "cursor-pointer hover:border-primary/40 hover:bg-accent/60",
            !clickable && "cursor-default",
          );

          const labelBlock = (
            <span className="flex min-w-0 flex-col">
              <span className={cn("min-w-0 truncate", active && "font-semibold")}>
                {step.shortLabel ? (
                  <>
                    <span className="sm:hidden">{step.shortLabel}</span>
                    <span className="hidden sm:inline">{step.label}</span>
                  </>
                ) : (
                  step.label
                )}
              </span>
              {showDescriptions && step.description ? (
                <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
                  {step.description}
                </span>
              ) : null}
            </span>
          );

          const content = (
            <>
              {badge}
              {labelBlock}
              <span className="sr-only">
                {`, step ${index + 1} of ${steps.length}, ${stateLabel}`}
                {step.description ? `. ${step.description}` : ""}
              </span>
            </>
          );

          const accessibleLabel = `${step.label}, step ${index + 1} of ${steps.length}, ${stateLabel}`;
          const tooltip = step.description ?? step.label;

          return (
            <li
              key={step.id}
              className={cn("flex min-w-0 items-center gap-1.5", !vertical && "shrink-0")}
            >
              {onStepChange ? (
                <button
                  type="button"
                  className={pillClassName}
                  disabled={!canNavigate}
                  aria-current={active ? "step" : undefined}
                  aria-label={accessibleLabel}
                  title={tooltip}
                  onClick={() => onStepChange(step.id)}
                >
                  {content}
                </button>
              ) : (
                <div
                  className={pillClassName}
                  role="group"
                  aria-current={active ? "step" : undefined}
                  aria-label={accessibleLabel}
                  title={tooltip}
                >
                  {content}
                </div>
              )}
              {!isLast ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "pointer-events-none flex shrink-0 items-center justify-center",
                    done ? "text-success/60" : "text-muted-foreground/60",
                  )}
                >
                  {vertical ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
