import { CheckCircle2, ClipboardCheck, Gauge, ListChecks, ShieldAlert } from "lucide-react";

import { MetricCard } from "@/components/qa/metric-card";
import { formatPercentage } from "@/components/workflow/test-intelligence-shared";
import type { ExistingReviewResult } from "@/components/workflow/test-intelligence-types";

import { countTraceabilityStatuses, scoreMetricTone } from "../lib/traceability-text";

/* Top summary metrics for the review step. Keeps the original four cards and
 * adds a fifth "Recommendations ready" card (data already in frontend state).
 * The grid wraps cleanly 2 -> 3 -> 5 across breakpoints. */

export function ReviewMetrics({ result }: { result: ExistingReviewResult }) {
  const counts = countTraceabilityStatuses(result.traceabilityMatrix);
  const gapCount = counts["Partially covered"] + counts["Not covered"] + counts["Needs review"];
  const recommendationCount = result.suggestedAdditions.length;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <MetricCard
        title="Coverage Score"
        value={formatPercentage(result.coverageScore)}
        description="Overall linked-test coverage."
        icon={Gauge}
        tone={scoreMetricTone(result.coverageScore)}
      />
      <MetricCard
        title="Coverage Points"
        value={String(result.traceabilityMatrix.length)}
        description="Atomic points reviewed."
        icon={ClipboardCheck}
        tone="blue"
      />
      <MetricCard
        title="Covered"
        value={String(counts.Covered)}
        description="Points with enough evidence."
        icon={CheckCircle2}
        tone="green"
      />
      <MetricCard
        title="Gaps"
        value={String(gapCount)}
        description="Partial, missing, or needs review."
        icon={ShieldAlert}
        tone={gapCount ? "red" : "green"}
      />
      <MetricCard
        title="Recommendations ready"
        value={String(recommendationCount)}
        description="Suggested test additions."
        icon={ListChecks}
        tone={recommendationCount ? "purple" : "neutral"}
      />
    </div>
  );
}
