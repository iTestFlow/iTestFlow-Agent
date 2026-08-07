/**
 * Secret scrubbing for everything the execution worker persists: step
 * observations, error messages, console lines, and report detail. This is the
 * primary redaction guarantee — the MCP server's --secrets flag is used as
 * defense-in-depth only, since it is a pre-1.0 feature that may drift.
 */

export const REDACTION_MARKER = "[REDACTED]";

export type Scrubber = (text: string) => string;

/**
 * Build a scrubber for the given secret representations (see
 * buildScrubValues in test-execution/secret-resolution). Longer values are
 * replaced first so partial overlaps cannot leak suffixes.
 */
export function createScrubber(scrubValues: readonly string[]): Scrubber {
  const ordered = [...new Set(scrubValues)]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  if (ordered.length === 0) return (text) => text;
  return (text: string) => {
    let output = text;
    for (const value of ordered) {
      output = output.split(value).join(REDACTION_MARKER);
    }
    return output;
  };
}

/** Scrub every string leaf of a JSON-safe value (observations, candidates). */
export function scrubDeep<T>(value: T, scrub: Scrubber): T {
  if (typeof value === "string") return scrub(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, scrub)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = scrubDeep(entry, scrub);
    }
    return output as T;
  }
  return value;
}
