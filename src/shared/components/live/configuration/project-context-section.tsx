"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FormState } from "./form-state";
import { Field } from "./section-card";

const PRESETS: { label: string; value: number }[] = [
  { label: "Focused", value: 5 },
  { label: "Recommended", value: 8 },
  { label: "Broad", value: 12 },
];

export function ProjectContextSection({
  form,
  update,
}: {
  form: FormState;
  update: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
}) {
  return (
    <Field
      label="Related work items to retrieve"
      htmlFor="retrieval-top-k"
      description="Recommended is used by default. Higher values give the AI more context but may increase token usage. Pinned and linked items are always added on top."
    >
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset.value}
            type="button"
            size="sm"
            variant={form.retrievalTopK === preset.value ? "default" : "outline"}
            aria-pressed={form.retrievalTopK === preset.value}
            onClick={() => update("retrievalTopK", preset.value)}
          >
            {preset.label}: {preset.value}
          </Button>
        ))}
        <Input
          id="retrieval-top-k"
          aria-label="Related work items to retrieve"
          type="number"
          min={1}
          max={25}
          step={1}
          className="h-9 w-24 border-input bg-card text-foreground"
          value={form.retrievalTopK}
          onChange={(event) => update("retrievalTopK", Number(event.target.value || "8"))}
        />
      </div>
    </Field>
  );
}
