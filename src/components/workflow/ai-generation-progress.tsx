"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CheckCircle2, Loader2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Callout } from "@/components/qa/callout";
import { ErrorState } from "@/components/qa/error-state";
import { cn } from "@/lib/utils";
import { mapFriendlyError } from "@/components/workflow/ai-generation-errors";
import type { AiGenerationError, AiGenerationStatus } from "@/components/workflow/use-ai-generation";
import { AiGenerationMetrics } from "@/components/workflow/ai-generation-metrics";
import { LlmLoadingGameShell } from "@/components/workflow/llm-loading-games/LlmLoadingGameShell";
import type { LlmLoadingGamePanelController } from "@/components/workflow/llm-loading-games/use-llm-loading-game-session";

export { mapFriendlyError };

/* --------------------------------------------------------------------------
 * Reusable AI generation progress panel. Renders in the same slot where the
 * final result will appear, so the page does not jump. Communicates honest
 * pipeline status (no fabricated AI content) with an indeterminate top bar,
 * a step list, live elapsed time, skeleton placeholders, and friendly
 * error/cancelled states with retry.
 * ------------------------------------------------------------------------ */

export type AiGenerationVariant = "analysis" | "test-design" | "coverage" | "advice" | "generic";

export type AiGenerationProgressProps = {
  status: AiGenerationStatus;
  title?: string;
  description?: string;
  elapsedSeconds?: number;
  currentStepLabel?: string;
  /** Optional accurate persistence guidance for background-backed generation. */
  activeHint?: string;
  /** Reserved for future streaming; unused while the backend does not stream. */
  streamedText?: string;
  error?: AiGenerationError | null;
  errorMessage?: string | null;
  canCancel?: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
  variant?: AiGenerationVariant;
  /** "full" = generation; "prep" = short External-LLM prompt preparation. */
  mode?: "full" | "prep";
  /** Optional waiting-game controller. Only rendered for full AI generation. */
  loadingGame?: LlmLoadingGamePanelController;
};

const DEFAULT_TITLE = "Generating with AI";
const PREP_TITLE = "Preparing prompt";
const ACTIVE_GENERATION_STATUSES: ReadonlySet<AiGenerationStatus> = new Set([
  "preparing_context",
  "building_prompt",
  "sending_request",
  "waiting_llm",
  "streaming",
  "validating_response",
]);

function dynamicSubtitle(status: AiGenerationStatus, mode: "full" | "prep"): string {
  if (mode === "prep") {
    switch (status) {
      case "preparing_context":
        return "Preparing selected work item context…";
      case "building_prompt":
      case "sending_request":
      case "waiting_llm":
      case "validating_response":
        return "Building the external LLM prompt…";
      default:
        return "Preparing prompt…";
    }
  }
  switch (status) {
    case "preparing_context":
      return "Preparing selected work item context…";
    case "building_prompt":
      return "Building the AI prompt with the selected knowledge…";
    case "sending_request":
      return "Sending the request to the LLM provider…";
    case "waiting_llm":
      return "Waiting for the AI response. This may take a moment…";
    case "validating_response":
      return "Validating and formatting the AI response…";
    default:
      return "Working…";
  }
}

type StepState = "done" | "current" | "future";

type StepDef = { key: string; label: string; matches: AiGenerationStatus[] };

const FULL_STEPS: StepDef[] = [
  { key: "prepare", label: "Preparing context", matches: ["preparing_context"] },
  { key: "build", label: "Building prompt", matches: ["building_prompt"] },
  { key: "wait", label: "Waiting for AI", matches: ["sending_request", "waiting_llm"] },
  { key: "validate", label: "Validating response", matches: ["validating_response"] },
];

const PREP_STEPS: StepDef[] = [
  { key: "prepare", label: "Preparing context", matches: ["preparing_context"] },
  { key: "build", label: "Building external LLM prompt", matches: ["building_prompt", "sending_request", "waiting_llm", "validating_response"] },
];

function stepStateFor(steps: StepDef[], index: number, status: AiGenerationStatus): StepState {
  const activeIndex = steps.findIndex((step) => step.matches.includes(status));
  // status not matched (e.g. completed) → treat everything as done.
  if (activeIndex === -1) return "done";
  if (index < activeIndex) return "done";
  if (index === activeIndex) return "current";
  return "future";
}

function IndeterminateBar({ active }: { active: boolean }) {
  if (!active) return <div className="h-0.5 w-full bg-transparent" aria-hidden="true" />;
  return (
    <div className="relative h-0.5 w-full overflow-hidden bg-primary/15" role="presentation" aria-hidden="true">
      <div className="absolute inset-y-0 w-1/3 bg-primary motion-reduce:left-0 motion-reduce:w-full motion-reduce:animate-none animate-[itf-indeterminate_1.15s_ease-in-out_infinite]" />
    </div>
  );
}

function PulsingDots() {
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-primary motion-reduce:animate-none animate-pulse"
          style={{ animationDelay: `${index * 150}ms` }}
        />
      ))}
    </span>
  );
}

function StepList({
  steps,
  status,
  currentStepLabel,
}: {
  steps: StepDef[];
  status: AiGenerationStatus;
  currentStepLabel?: string;
}) {
  return (
    <ol className="divide-y divide-border rounded-lg border border-border" aria-hidden="true">
      {steps.map((step, index) => {
        const state = stepStateFor(steps, index, status);
        const isWaiting = step.key === "wait" || step.key === "build";
        const label = state === "current" && currentStepLabel ? currentStepLabel : step.label;
        return (
          <li key={step.key} className="flex items-center gap-2 px-3 py-2 text-sm">
            <span className="flex size-5 shrink-0 items-center justify-center">
              {state === "done" ? (
                <CheckCircle2 className="size-4 text-success" />
              ) : state === "current" ? (
                <Loader2 className="size-4 animate-spin text-primary motion-reduce:animate-none" />
              ) : (
                <span className="size-2 rounded-full bg-muted-foreground/40" />
              )}
            </span>
            <span
              className={cn(
                "flex-1",
                state === "current" && "font-medium text-foreground",
                state === "done" && "text-muted-foreground",
                state === "future" && "text-muted-foreground/70",
              )}
            >
              {label}
            </span>
            {state === "current" && isWaiting ? <PulsingDots /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function VariantSkeleton({ variant }: { variant: AiGenerationVariant }) {
  if (variant === "analysis") {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="grid gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-24" />
        ))}
      </div>
    );
  }
  if (variant === "test-design") {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="grid gap-3 lg:grid-cols-3">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
        {[0, 1, 2, 3, 4].map((index) => (
          <Skeleton key={index} className="h-9" />
        ))}
      </div>
    );
  }
  if (variant === "coverage") {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="grid gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (variant === "advice") {
    return (
      <div className="space-y-3" aria-hidden="true">
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {[0, 1, 2, 3, 4].map((index) => (
            <Skeleton key={index} className="h-20" />
          ))}
        </div>
        <Skeleton className="h-32" />
      </div>
    );
  }
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-6" />
      ))}
    </div>
  );
}

function PanelShell({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <Card className="gap-0 overflow-hidden py-0" aria-busy={active}>
      <IndeterminateBar active={active} />
      <div className="space-y-4 p-4">{children}</div>
    </Card>
  );
}

export function AiGenerationProgress({
  status,
  title,
  description,
  elapsedSeconds,
  currentStepLabel,
  activeHint,
  error,
  errorMessage,
  canCancel,
  onCancel,
  onRetry,
  variant = "generic",
  mode = "full",
  loadingGame,
}: AiGenerationProgressProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const scrolledForRunRef = useRef(false);
  const retryButtonRef = useRef<HTMLButtonElement | null>(null);

  // Full auto-generation panels are rendered below the input card, so make the
  // active "Generating with AI" panel visible as soon as it appears.
  useEffect(() => {
    if (mode !== "full" || !ACTIVE_GENERATION_STATUSES.has(status)) {
      scrolledForRunRef.current = false;
      return;
    }
    if (scrolledForRunRef.current) return;

    scrolledForRunRef.current = true;
    window.setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }, [mode, status]);

  // Move focus to the recovery action when generation fails or is cancelled.
  useEffect(() => {
    if (status === "failed" || status === "cancelled") {
      retryButtonRef.current?.focus();
    }
  }, [status]);

  if (status === "idle" || (status === "completed" && !loadingGame?.isGameOpen)) return null;

  if (status === "failed") {
    const resolvedError: AiGenerationError | null = error ?? (errorMessage ? { message: errorMessage } : null);
    return (
      <ErrorState
        title="Generation failed"
        message={mapFriendlyError({ code: resolvedError?.code, raw: resolvedError?.message })}
        technicalDetails={resolvedError?.technicalDetails ?? resolvedError?.message}
        technicalContext={resolvedError?.technicalContext}
        onRetry={onRetry}
      />
    );
  }

  if (status === "cancelled") {
    return (
      <Callout
        tone="warning"
        title="Generation was cancelled"
        action={
          onRetry ? (
            <Button ref={retryButtonRef} size="sm" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      >
        You cancelled this request. Any partial result was discarded.
      </Callout>
    );
  }

  const steps = mode === "prep" ? PREP_STEPS : FULL_STEPS;
  const resolvedTitle = title ?? (mode === "prep" ? PREP_TITLE : DEFAULT_TITLE);
  const subtitle = status === "completed" ? "Response is ready." : (description ?? dynamicSubtitle(status, mode));
  const active = ACTIVE_GENERATION_STATUSES.has(status);
  const gameOpen = mode === "full" && Boolean(loadingGame?.isGameOpen);

  return (
    <div ref={panelRef} className="scroll-mt-4">
      <PanelShell active={active}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-2">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
            <div className="min-w-0 space-y-0.5">
              <div className="font-heading text-base font-medium leading-snug text-foreground">{resolvedTitle}</div>
              <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
                {subtitle}
              </p>
            </div>
          </div>
          {typeof elapsedSeconds === "number" ? (
            <AiGenerationMetrics
              elapsedSeconds={elapsedSeconds}
              calculatingTokens={mode === "full"}
              showTokens={mode === "full"}
              className="sm:text-right"
            />
          ) : null}
        </div>

        <StepList steps={steps} status={status} currentStepLabel={currentStepLabel} />

        {mode === "full" ? (
          <>
            <p className="text-xs text-muted-foreground">
              {status === "completed"
                ? "Your generated response is available whenever you are ready."
                : (activeHint ?? "Please keep this page open while the response is being generated. Large stories or rich project context may take longer.")}
            </p>
            {loadingGame ? (
              <LlmLoadingGameShell
                isLoading={active}
                isReady={status === "completed"}
                controller={loadingGame}
              />
            ) : null}
            {gameOpen ? null : <VariantSkeleton variant={variant} />}
          </>
        ) : null}

        {active && canCancel && onCancel ? (
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={onCancel}>
              <X className="size-3.5" aria-hidden="true" />
              {mode === "prep" ? "Cancel" : "Stop generation"}
            </Button>
          </div>
        ) : null}
      </PanelShell>
    </div>
  );
}
