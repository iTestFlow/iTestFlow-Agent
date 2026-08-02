import "server-only";

/**
 * Shared, deliberately crude token estimation for prompt budgeting.
 *
 * A real tokenizer would have to match whichever provider the user configured, which
 * is not knowable here. Every consumer applies a safety margin on top, so being wrong
 * in the conservative direction costs nothing.
 *
 * A single chars-per-token rate cannot be conservative across scripts: English runs
 * ~4 chars/token on modern BPEs, Arabic/Cyrillic ~2, and CJK ~1 — a flat /4 undercounts
 * a Chinese work item 4x and overflows the model window the budgets exist to respect.
 * Three bands by UTF-16 code unit keep ASCII behavior exactly as before and charge
 * denser scripts at or above their real rates:
 *
 *   <= 0x7F           ASCII                                   /4
 *   0x80 - 0x2E7F     accented Latin, Greek, Cyrillic,        /2
 *                     Arabic, Hebrew, Indic
 *   >= 0x2E80         CJK ideographs, kana, Hangul,           /1
 *                     surrogates (emoji count 2 units)
 */
const ASCII_CHARS_PER_TOKEN = 4;
const MID_SCRIPT_CHARS_PER_TOKEN = 2;
const DENSE_SCRIPT_THRESHOLD = 0x2e80;

/** Fraction of a model's input limit a prompt may plan to occupy. */
export const PROMPT_BUDGET_SAFETY_FRACTION = 0.9;

/** Applied when the configured model's input limit is unknown. */
export const FALLBACK_MAX_INPUT_TOKENS = 16_000;

export function estimateTokens(text: string): number {
  let ascii = 0;
  let mid = 0;
  let dense = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) ascii += 1;
    else if (code < DENSE_SCRIPT_THRESHOLD) mid += 1;
    else dense += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + mid / MID_SCRIPT_CHARS_PER_TOKEN + dense);
}

/** The share of a model's window a prompt may spend, after its safety margin. */
export function usableInputTokens(maxInputTokens?: number): number {
  const limit =
    typeof maxInputTokens === "number" && Number.isFinite(maxInputTokens) && maxInputTokens > 0
      ? Math.floor(maxInputTokens)
      : FALLBACK_MAX_INPUT_TOKENS;
  return Math.floor(limit * PROMPT_BUDGET_SAFETY_FRACTION);
}
