"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

import { Card } from "@/components/ui/card";
import {
  MAX_OUTPUT_TOKEN_CAP_OPTIONS,
  RETRY_ATTEMPT_OPTIONS,
} from "@/modules/llm/llm-defaults";
import { cn } from "@/lib/utils";
import type { FormState } from "./form-state";
import { Field, NumberSelect } from "./section-card";

/**
 * Collapsible "Advanced LLM Controls" card (collapsed by default). Holds the
 * output-size cap and transient-retry count, which most teams never need to change.
 */
export function AdvancedLlmControls({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  const [open, setOpen] = useState(false);
  const contentId = "advanced-llm-controls-content";

  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start justify-between gap-3 px-4 text-left"
      >
        <span>
          <span className="block font-heading text-base font-medium text-foreground">Advanced LLM Controls</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            Bound output size and transient retries. The defaults work for most teams.
          </span>
        </span>
        <ChevronDown
          className={cn("mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div id={contentId} className="space-y-5 border-t border-border px-4 pt-5">
          <Field
            label="Maximum AI response size"
            htmlFor="llm-max-output"
            description="The most tokens the model may return per request. Higher allows longer responses but increases cost and latency."
          >
            <NumberSelect
              id="llm-max-output"
              ariaLabel="Maximum AI response size"
              value={form.maxOutputTokenCap}
              options={MAX_OUTPUT_TOKEN_CAP_OPTIONS}
              formatOption={(value) => `${value.toLocaleString()} tokens`}
              onChange={(value) => update("maxOutputTokenCap", value)}
            />
          </Field>

          <Field
            label="Retry attempts after temporary failures"
            htmlFor="llm-retry-attempts"
            description="How many times to retry after a network or retryable provider error. More retries improve reliability but can delay a final failure."
          >
            <NumberSelect
              id="llm-retry-attempts"
              ariaLabel="Retry attempts after temporary failures"
              value={form.retryAttempts}
              options={RETRY_ATTEMPT_OPTIONS}
              formatOption={(value) => (value === 0 ? "0 (disabled)" : `${value} ${value === 1 ? "retry" : "retries"}`)}
              onChange={(value) => update("retryAttempts", value)}
            />
          </Field>
        </div>
      ) : null}
    </Card>
  );
}
