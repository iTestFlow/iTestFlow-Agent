export type ApiErrorEnvelope = {
  error?: unknown;
  code?: unknown;
  technicalDetails?: unknown;
};

export function apiErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const message = (payload as ApiErrorEnvelope).error;
    if (typeof message === "string" && message.trim() && !looksLikeRawPayload(message)) {
      return message.trim();
    }
  }
  return fallback;
}

export async function responseErrorMessage(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null);
  return apiErrorMessage(payload, fallback);
}

export function caughtErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim() && !looksLikeRawPayload(error.message)) {
    return error.message;
  }
  return fallback;
}

function looksLikeRawPayload(value: string) {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed.includes('{"error"') ||
    /unexpected token ['"]?</i.test(trimmed) ||
    /<html|<!doctype html|<body|<pre/i.test(trimmed)
  );
}
