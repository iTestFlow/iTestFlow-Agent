"use client";

import { Card } from "@/components/ui/card";
import {
  MAX_OUTPUT_TOKEN_CAP_OPTIONS,
  RETRY_ATTEMPT_OPTIONS,
} from "@/modules/llm/llm-defaults";
import type { FormState } from "./form-state";
import { Field, NumberSelect } from "./section-card";

/**
 * Advanced LLM Controls card. Holds the output-size cap and transient-retry
 * count, which most teams rarely need to change.
 */
export function AdvancedLlmControls({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  const contentId = "advanced-llm-controls-content";

  return (
    <Card>
      <div className="px-4">
        <div>
          <span className="block font-heading text-base font-medium text-foreground">Advanced LLM Controls</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
            Bound output size and transient retries. The defaults work for most teams.
          </span>
        </div>
      </div>

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
    </Card>
  );
}
