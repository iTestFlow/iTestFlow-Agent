const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api.?key|value)/i;

function sanitizeString(value: string): string {
  let sanitized = value
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

export function sanitizeExecutionPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeExecutionPayload(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizeExecutionPayload(entry, depth + 1),
    ]));
  }
  return String(value).slice(0, 200);
}

export function sanitizeExecutionError(value: string): string {
  return sanitizeString(value).replace(/(?:authorization|cookie|password|secret|token|api.?key)\s*[:=]\s*\S+/gi, "[REDACTED]");
}
