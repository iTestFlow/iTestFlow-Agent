export const MAX_OUTPUT_TOKEN_CAP_OPTIONS = [16000, 32000, 64000] as const;
export const RETRY_ATTEMPT_OPTIONS = [0, 1, 2, 3] as const;

// Fallback ceiling for the plain-text generation path (generateText) when a caller does not
// pass a per-call maxTokens. Structured-output generation does not use this — it requests the
// full maxOutputTokenCap in a single call (see base-json-provider).
export const DEFAULT_TEXT_OUTPUT_TOKENS = 8000;
export const DEFAULT_MAX_OUTPUT_TOKEN_CAP = 32000;
export const DEFAULT_RETRY_ATTEMPTS = 1;

export type LLMControlSettings = {
  maxOutputTokenCap: number;
  retryAttempts: number;
};

export function normalizeLLMControlSettings(input: {
  maxOutputTokenCap?: unknown;
  retryAttempts?: unknown;
}): LLMControlSettings {
  return {
    maxOutputTokenCap: nearestAllowedValue(
      input.maxOutputTokenCap,
      MAX_OUTPUT_TOKEN_CAP_OPTIONS,
      DEFAULT_MAX_OUTPUT_TOKEN_CAP,
    ),
    retryAttempts: nearestAllowedValue(input.retryAttempts, RETRY_ATTEMPT_OPTIONS, DEFAULT_RETRY_ATTEMPTS),
  };
}

export function getMaxOutputTokenCapDefaultFromEnv(): number {
  return normalizeLLMControlSettings({
    maxOutputTokenCap: process.env.LLM_MAX_OUTPUT_TOKEN_CAP,
  }).maxOutputTokenCap;
}

function nearestAllowedValue(
  value: unknown,
  options: readonly number[],
  fallback: number,
) {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;

  return options.reduce((nearest, option) => {
    const optionDistance = Math.abs(option - numericValue);
    const nearestDistance = Math.abs(nearest - numericValue);
    return optionDistance < nearestDistance ? option : nearest;
  }, options[0]);
}
