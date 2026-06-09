import "server-only";

/**
 * Helpers for tolerating model-specific request-parameter incompatibilities.
 *
 * OpenAI's GPT-5 / o-series reasoning models renamed `max_tokens` to `max_completion_tokens`;
 * sending `max_tokens` returns a 400. The OpenAI provider detects that error and renames the
 * field, then remembers it for the rest of the provider instance's lifetime — so newer models
 * work without maintaining a per-model allow-list, while GPT-4o/4.1-class models keep `max_tokens`.
 */

export function withMaxCompletionTokens(body: Record<string, unknown>) {
  if (!("max_tokens" in body)) return body;
  const next = { ...body };
  next.max_completion_tokens = next.max_tokens;
  delete next.max_tokens;
  return next;
}

export function isMaxTokensRenameError(errorText: string) {
  return /max_tokens/i.test(errorText) && /max_completion_tokens/i.test(errorText);
}
