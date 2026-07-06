import "server-only";

import { z } from "zod";

// Classifies failures from knowledge-base generation (extract/preview routes) so the
// routes can map them to actionable 422 responses instead of a generic 503. A message
// can match BOTH classifiers (e.g. truncation detected while parsing JSON) — callers
// must check the truncated classifier first, since truncation is the root cause.

export const InvalidKnowledgeBaseOutputMessage =
  "The model returned invalid knowledge-base JSON. No data was saved. Please retry extraction or reduce indexed context size.";
export const TruncatedKnowledgeBaseOutputMessage =
  "The model ran out of output tokens before completing the knowledge-base JSON. No data was saved. Please retry extraction; if it still fails, increase max tokens or index a narrower context.";

export function isTruncatedKnowledgeBaseOutputError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /max output token|token budget|finishReason.*MAX_TOKENS/i.test(error.message);
}

export function isInvalidKnowledgeBaseOutputError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return /json|parse|validation|schema/i.test(error.message);
}
