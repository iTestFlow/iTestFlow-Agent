const SENSITIVE_COLUMN = /(?:pass(?:word)?|secret|token|api[_-]?key|credential|private[_-]?key|authorization|session[_-]?id)/i;

/** Keep capture values accessible in worker memory but out of JSON evidence. */
export function protectDatabaseResult<T extends { rows: Record<string, unknown>[] }>(result: T): T {
  Object.defineProperty(result, "rows", { value: result.rows, enumerable: false });
  return result;
}

/** Bound both worker-local captures and safe evidence before returning from a driver. */
export function boundedDatabaseRows(rows: readonly Record<string, unknown>[], maxRows: number, maxBytes: number, sensitiveValues: readonly string[] = []) {
  const limit = Math.max(0, Math.min(500, Math.floor(maxRows)));
  const byteLimit = Math.max(0, Math.min(1024 * 1024, Math.floor(maxBytes)));
  const bounded: Record<string, unknown>[] = [];
  let bytes = 0;
  let truncated = rows.length > limit;
  for (const row of rows.slice(0, limit)) {
    const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalize(value)]));
    const size = Buffer.byteLength(JSON.stringify(normalized));
    if (bytes + size > byteLimit) { truncated = true; break; }
    bytes += size;
    bounded.push(normalized);
  }
  const secrets = sensitiveValues.filter((value) => value.length > 0);
  const safeRows = bounded.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [
    column, SENSITIVE_COLUMN.test(column) ? "[REDACTED]" : redactValue(value, secrets),
  ])));
  return { rows: bounded, safeRows, truncated };
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    return secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  return value;
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<binary:${value.length} bytes>`;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(normalize);
  return "[complex value]";
}
