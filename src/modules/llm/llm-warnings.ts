import "server-only";

// Spread into an audit log `details` object to record that an LLM response was truncated at the
// output-token cap. Returns an empty object when there is nothing to flag, so the common (clean)
// case adds no fields. The activity log surfaces these details verbatim.
export function truncationAuditDetails(
  warnings?: string[],
): { truncated: true; truncationWarning: string } | Record<string, never> {
  const message = warnings?.find((entry) => entry.trim().length > 0);
  return message ? { truncated: true, truncationWarning: message } : {};
}

// Truncation surfaces two ways: as a success-path warning (valid-but-short JSON) or, more often
// for structured output, as a thrown parse error once the cut-off JSON can't be repaired. This
// matches the error-message signatures both paths (and the providers) produce, so a failed
// generation can be flagged as truncation-caused in the activity log.
const TRUNCATION_ERROR_SIGNATURE = /output-token limit|max(?:imum)? output token|output token budget|MAX_TOKENS/i;

export function isTruncationErrorMessage(message: string): boolean {
  return TRUNCATION_ERROR_SIGNATURE.test(message);
}
