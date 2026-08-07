/**
 * Polling cadence for run progress — mirrors the Knowledge Hub curve
 * (knowledge-build.tsx buildJobPollDelay): fast at first, then relaxed, with
 * failure backoff. Pure so it is unit-testable.
 */

const FAILURE_BACKOFF_MS = [5_000, 15_000, 30_000] as const;

export function runPollDelay(elapsedMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures > 0) {
    return FAILURE_BACKOFF_MS[Math.min(consecutiveFailures, FAILURE_BACKOFF_MS.length) - 1];
  }
  if (elapsedMs < 15_000) return 2_000;
  if (elapsedMs < 2 * 60_000) return 5_000;
  return 15_000;
}
