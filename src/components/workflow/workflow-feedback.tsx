"use client";

import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ActiveProjectScope } from "@/shared/lib/active-project";

type FeedbackLabel =
  | "accepted_without_edits"
  | "accepted_minor_edits"
  | "accepted_major_edits"
  | "rejected";

export function WorkflowFeedback({
  scope,
  runId,
}: {
  scope: ActiveProjectScope | null;
  runId?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [label, setLabel] = useState<FeedbackLabel | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/settings/runtime", { cache: "no-store" })
      .then((response) => response.json())
      .then((summary) => {
        if (!cancelled) setEnabled(summary.dashboardValueMetrics?.feedbackPromptEnabled !== false);
      })
      .catch(() => {
        if (!cancelled) setEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(rating: 1 | 2 | 3) {
    if (!scope || !runId || submitting || submitted) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/analytics/workflow-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, runId, rating, label }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Feedback could not be saved.");
      }
      setSubmitted(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Feedback could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!enabled || !scope || !runId) return null;
  if (submitted) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
        <CheckCircle2 className="size-4" />
        Feedback saved. Thank you.
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
      <div>
        <div className="text-sm font-semibold text-foreground">Was this output useful?</div>
        <div className="mt-1 text-xs text-muted-foreground">Optional feedback improves adoption and usefulness metrics.</div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={label} onValueChange={(value) => setLabel(value as FeedbackLabel)}>
          <SelectTrigger className="sm:w-[240px]" aria-label="Output edit quality">
            <SelectValue placeholder="Edit quality (optional)" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="accepted_without_edits">Accepted without edits</SelectItem>
            <SelectItem value="accepted_minor_edits">Accepted with minor edits</SelectItem>
            <SelectItem value="accepted_major_edits">Accepted with major edits</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={submitting} onClick={() => void submit(3)}>Useful</Button>
          <Button size="sm" variant="outline" disabled={submitting} onClick={() => void submit(2)}>Partially useful</Button>
          <Button size="sm" variant="outline" disabled={submitting} onClick={() => void submit(1)}>Not useful</Button>
        </div>
      </div>
      {error ? <p className="text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
