export function calculateEstimatedSavings(manualBaselineMinutes: number, actualDurationMinutes: number) {
  return Math.max(manualBaselineMinutes - actualDurationMinutes, 0);
}

// Labor saved: fully-manual human effort (M) minus the human review/edit effort (R)
// of the AI output. Excludes LLM/machine time — the human is not working while the
// model runs. This is the ROI/"time freed up" number.
export function calculateLaborSaved(manualBaselineMinutes: number, reviewMinutes: number) {
  return Math.max(manualBaselineMinutes - reviewMinutes, 0);
}

// Cycle-time saved: how much faster the item is done end-to-end — manual effort (M)
// minus the assisted turnaround (LLM generation time + human review). When the LLM
// time is unknown (timestamps not captured), it collapses to the labor figure.
export function calculateCycleSaved(
  manualBaselineMinutes: number,
  generationMinutes: number | null,
  reviewMinutes: number,
) {
  return Math.max(manualBaselineMinutes - ((generationMinutes ?? 0) + reviewMinutes), 0);
}

export function calculateElapsedMinutes(startedAt: string, endedAt: string) {
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  return Math.max((ended - started) / 60_000, 0);
}

export function calculateRate(numerator: number, denominator: number) {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function isRealizedValue(input: {
  itemsPublished?: number;
  itemsSelected?: number;
  automationCompleted?: boolean;
}) {
  return Boolean(
    input.automationCompleted
    || (input.itemsPublished ?? 0) > 0
    || (input.itemsSelected ?? 0) > 0
  );
}
