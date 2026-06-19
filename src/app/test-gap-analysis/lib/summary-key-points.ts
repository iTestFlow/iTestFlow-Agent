/**
 * Pure, presentation-agnostic helper that turns the LLM's free-text review
 * `summary` (a single plain string — see `ExistingReviewResult.summary`) into a
 * scannable list of "Key points" when it can be split cleanly into multiple
 * sentences, and falls back to the original paragraph otherwise.
 *
 * No backend/schema change: this only reshapes existing text on the client.
 */

export type SummaryKeyPoints =
  | { kind: "points"; points: string[] }
  | { kind: "paragraph"; text: string };

/** Private-use delimiters used to mask spans so their periods don't split. */
const MASK_OPEN = String.fromCharCode(0xe000);
const MASK_CLOSE = String.fromCharCode(0xe001);

/** Abbreviations whose trailing period must not be treated as a sentence end. */
const ABBREVIATIONS = ["e.g.", "i.e.", "etc.", "vs.", "Fig.", "No.", "cf."];

/** A bullet must be at least this long to count as a real sentence. */
const MIN_SENTENCE_LENGTH = 12;

export function splitSummaryKeyPoints(summary: string): SummaryKeyPoints {
  const text = summary.trim();
  if (!text) return { kind: "paragraph", text: "" };

  const masks: string[] = [];
  const mask = (value: string) => {
    const token = `${MASK_OPEN}${masks.length}${MASK_CLOSE}`;
    masks.push(value);
    return token;
  };

  // Mask decimals (e.g. "85.5") and known abbreviations so the splitter below
  // never breaks on their internal periods.
  let masked = text.replace(/\d+\.\d+/g, (match) => mask(match));
  for (const abbreviation of ABBREVIATIONS) {
    masked = masked.replace(new RegExp(escapeRegExp(abbreviation), "gi"), (match) => mask(match));
  }

  const restorePattern = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, "g");
  const restore = (value: string) =>
    value.replace(restorePattern, (_, index: string) => masks[Number(index)] ?? "");

  const sentences = masked
    // Split after terminal punctuation when the next token starts a new clause.
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((sentence) => restore(sentence).replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length > 0);

  if (sentences.length >= 2 && sentences.every((sentence) => sentence.length >= MIN_SENTENCE_LENGTH)) {
    return { kind: "points", points: sentences };
  }

  return { kind: "paragraph", text };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
