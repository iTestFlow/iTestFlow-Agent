const SENSITIVE_COLUMN = /(password|passwd|secret|token|authorization|cookie|api[_-]?key|private[_-]?key)/i;

export function boundedDatabaseRows(
  rows: readonly Record<string, unknown>[],
  maxRows: number,
  maxBytes: number,
) {
  const bounded: Record<string, unknown>[] = [];
  let bytes = 0;
  let truncated = rows.length > maxRows;
  for (const row of rows.slice(0, maxRows)) {
    const serialized = JSON.stringify(row);
    if (bytes + Buffer.byteLength(serialized) > maxBytes) { truncated = true; break; }
    bytes += Buffer.byteLength(serialized);
    bounded.push(row);
  }
  const safeRows = bounded.map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [
    column,
    SENSITIVE_COLUMN.test(column) ? "[REDACTED]" : normalizeDatabaseValue(value),
  ])));
  return { rows: bounded.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeDatabaseValue(value)]))), safeRows, truncated };
}

function normalizeDatabaseValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<binary:${value.length} bytes>`;
  return value;
}
