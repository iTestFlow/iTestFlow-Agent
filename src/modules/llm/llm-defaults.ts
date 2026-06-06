export const MAX_TOKEN_OPTIONS = [4000, 8000, 16000, 32000] as const;
export const MAX_OUTPUT_TOKEN_CAP_OPTIONS = [8000, 16000, 32000, 64000] as const;
export const RETRY_ATTEMPT_OPTIONS = [0, 1, 2, 3] as const;
export const MAX_TRUNCATION_ATTEMPT_OPTIONS = [1, 2, 3, 4] as const;

export const DEFAULT_MAX_TOKENS = 8000;
export const DEFAULT_MAX_OUTPUT_TOKEN_CAP = 32000;
export const DEFAULT_RETRY_ATTEMPTS = 1;
export const DEFAULT_MAX_TRUNCATION_ATTEMPTS = 3;

export type LLMControlSettings = {
  maxTokens: number;
  maxOutputTokenCap: number;
  retryAttempts: number;
  maxTruncationAttempts: number;
};

export function normalizeLLMControlSettings(input: {
  maxTokens?: unknown;
  maxOutputTokenCap?: unknown;
  retryAttempts?: unknown;
  maxTruncationAttempts?: unknown;
}): LLMControlSettings {
  const maxTokens = nearestAllowedValue(input.maxTokens, MAX_TOKEN_OPTIONS, DEFAULT_MAX_TOKENS);
  const normalizedCap = nearestAllowedValue(
    input.maxOutputTokenCap,
    MAX_OUTPUT_TOKEN_CAP_OPTIONS,
    DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  );
  const maxOutputTokenCap =
    MAX_OUTPUT_TOKEN_CAP_OPTIONS.find((option) => option >= maxTokens && option >= normalizedCap)
    ?? MAX_OUTPUT_TOKEN_CAP_OPTIONS[MAX_OUTPUT_TOKEN_CAP_OPTIONS.length - 1];

  return {
    maxTokens,
    maxOutputTokenCap,
    retryAttempts: nearestAllowedValue(input.retryAttempts, RETRY_ATTEMPT_OPTIONS, DEFAULT_RETRY_ATTEMPTS),
    maxTruncationAttempts: nearestAllowedValue(
      input.maxTruncationAttempts,
      MAX_TRUNCATION_ATTEMPT_OPTIONS,
      DEFAULT_MAX_TRUNCATION_ATTEMPTS,
    ),
  };
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
