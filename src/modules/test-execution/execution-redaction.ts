const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api.?key|value|text)/i;

/** Secrets shorter than this are too likely to shred normal prose when scrubbed. */
const MIN_SECRET_SCRUB_LENGTH = 4;

function scrubSecretValues(value: string, secrets: readonly string[]): string {
  let scrubbed = value;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_SCRUB_LENGTH) continue;
    scrubbed = scrubbed.split(secret).join("[REDACTED]");
  }
  return scrubbed;
}

function sanitizeString(value: string, secrets: readonly string[]): string {
  let sanitized = scrubSecretValues(value, secrets)
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]");
  if (/^https?:\/\//i.test(sanitized)) {
    try {
      const url = new URL(sanitized);
      url.search = "";
      url.hash = "";
      sanitized = url.toString();
    } catch {
      // Keep the already-redacted string when it only resembles a URL.
    }
  }
  return sanitized.slice(0, 4_000);
}

export function sanitizeExecutionPayload(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeString(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeExecutionPayload(entry, secrets, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeExecutionPayload(entry, secrets, depth + 1),
    ]));
  }
  return String(value).slice(0, 200);
}

export function sanitizeExecutionError(value: string, secrets: readonly string[] = []): string {
  return sanitizeString(value, secrets).replace(/(?:authorization|cookie|password|secret|token|api.?key)\s*[:=]\s*\S+/gi, "[REDACTED]");
}
