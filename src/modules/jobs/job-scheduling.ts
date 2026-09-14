/** Normalize internal scheduling deadlines before they can reach persisted queue state. */
export function normalizeJobRunAfter(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError("The job scheduling deadline is invalid.");
  return new Date(timestamp).toISOString();
}

/** An attempted operation failed; consume its claim and honor its persisted retry deadline. */
export class JobRetryError extends Error {
  readonly retryNotBefore: string;

  constructor(message: string, readonly code: string, retryNotBefore: string) {
    super(message);
    this.name = "JobRetryError";
    this.retryNotBefore = normalizeJobRunAfter(retryNotBefore);
  }
}

/** No operation was attempted; release the claim without consuming the retry budget. */
export class JobDeferredError extends Error {
  readonly runAfter: string;

  constructor(runAfter: string) {
    super("The job is waiting for its operation to become eligible.");
    this.name = "JobDeferredError";
    this.runAfter = normalizeJobRunAfter(runAfter);
  }
}
