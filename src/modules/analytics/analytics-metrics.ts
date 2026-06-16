export function calculateEstimatedSavings(manualBaselineMinutes: number, actualDurationMinutes: number) {
  return Math.max(manualBaselineMinutes - actualDurationMinutes, 0);
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
  feedbackRating?: number | null;
  automationCompleted?: boolean;
}) {
  return Boolean(
    input.automationCompleted
    || (input.itemsPublished ?? 0) > 0
    || (input.itemsSelected ?? 0) > 0
    || (input.feedbackRating ?? 0) >= 2,
  );
}
