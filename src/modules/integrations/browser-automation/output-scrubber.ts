/**
 * Secret scrubbing for everything the execution worker persists: step
 * observations, error messages, console lines, and report detail. This is the
 * primary redaction guarantee — the MCP server's --secrets flag is used as
 * defense-in-depth only, since it is a pre-1.0 feature that may drift.
 */

export const REDACTION_MARKER = "[REDACTED]";

export type Scrubber = (text: string) => string;

type MutableScrubberState = {
  values: Set<string>;
  substringValues: string[];
  tokenValues: string[];
};

const mutableScrubbers = new WeakMap<Scrubber, MutableScrubberState>();

/**
 * Build a scrubber for the given secret representations (see
 * buildScrubValues in test-execution/secret-resolution). Longer values are
 * replaced first so partial overlaps cannot leak suffixes.
 */
export function createScrubber(scrubValues: readonly string[]): Scrubber {
  const state: MutableScrubberState = {
    values: new Set(scrubValues.filter((value) => value.length > 0)),
    substringValues: [],
    tokenValues: [],
  };
  refreshOrder(state);
  const scrub: Scrubber = (text: string) => scrubWithState(text, state);
  mutableScrubbers.set(scrub, state);
  return scrub;
}

/**
 * Extend an existing scrubber with values discovered during execution. The
 * returned function must be retained: scrubbers created here are updated in
 * place, while a caller-supplied scrubber is safely composed with a new one.
 */
export function addScrubValues(scrub: Scrubber, scrubValues: readonly string[]): Scrubber {
  const additions = scrubValues.filter((value) => value.length > 0);
  if (additions.length === 0) return scrub;
  const existing = mutableScrubbers.get(scrub);
  if (existing) {
    for (const value of additions) existing.values.add(value);
    refreshOrder(existing);
    return scrub;
  }

  const state: MutableScrubberState = {
    values: new Set(additions),
    substringValues: [],
    tokenValues: [],
  };
  refreshOrder(state);
  const composed: Scrubber = (text: string) => scrubWithState(scrub(text), state);
  mutableScrubbers.set(composed, state);
  return composed;
}

function refreshOrder(state: MutableScrubberState): void {
  state.substringValues = [...state.values]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  state.tokenValues = [...state.values]
    .filter((value) => value.length > 0 && value.length < 4)
    .sort((a, b) => b.length - a.length);
}

function scrubWithState(text: string, state: MutableScrubberState): string {
  let output = text;
  for (const value of state.substringValues) {
    output = output.split(value).join(REDACTION_MARKER);
  }
  for (const value of state.tokenValues) {
    const pattern = new RegExp(
      `(^|[^A-Za-z0-9_])${escapeRegExp(value)}(?=$|[^A-Za-z0-9_])`,
      "g",
    );
    output = output.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTION_MARKER}`);
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
