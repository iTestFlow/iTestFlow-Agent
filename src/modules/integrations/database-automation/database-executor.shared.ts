import { DatabaseExecutorError, type DatabaseExecutionResult } from "./database-executor.port";

/**
 * Behavior shared by the three transactional executors: rollback outcome
 * tracking, cancellation classification, query-error normalization, and LIKE
 * pattern escaping. One copy — the per-driver files keep only driver logic.
 */

export type RollbackOutcome = { ok: true } | { ok: false; error: unknown };

export async function rollbackOutcome(rollback: () => Promise<unknown>): Promise<RollbackOutcome> {
  try {
    await rollback();
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

export function assertNotCanceled(signal: AbortSignal, driver: string): void {
  if (signal.aborted) throw cancellationError(driver, false);
}

export function cancellationError(
  driver: string,
  uncertainSideEffect: boolean,
  rollback?: RollbackOutcome,
): DatabaseExecutorError {
  const rollbackFailed = rollback?.ok === false;
  return new DatabaseExecutorError(
    rollbackFailed
      ? `${driver} execution was canceled, but rollback could not be confirmed.`
      : `${driver} execution was canceled before commit.`,
    "transport",
    uncertainSideEffect,
    rollbackFailed ? rollback.error : undefined,
  );
}

export function queryError(
  command: string,
  durationMs: number,
  sqlState: string,
  errorMessage: string,
): DatabaseExecutionResult {
  return {
    status: "query_error",
    command,
    rowCount: 0,
    columns: [],
    rows: [],
    safeRows: [],
    truncated: false,
    durationMs,
    sqlState,
    errorMessage,
  };
}

/**
 * Escape LIKE/ILIKE metacharacters in a user-supplied pattern fragment so a
 * "%"/"_" in a table filter matches literally instead of widening the scan.
 * All three servers honor backslash as the escape character here (SQL Server
 * via an explicit ESCAPE clause at the call site).
 */
export function escapeLikePattern(fragment: string): string {
  return fragment.replace(/[\\%_]/g, "\\$&");
}

/** Caps on how much of an account's visible surface one run may carry. */
export const MAX_DISCOVERED_SCHEMAS = 30;
export const MAX_DISCOVERED_TABLES = 300;
export const MAX_DISCOVERED_COLUMNS = 5_000;

/**
 * Canonical comparison key for a discovered object. PostgreSQL and MySQL fold
 * unquoted identifiers to lower case (the form the SQL parser reports), and
 * SQL Server compares case-insensitively under its default collation — so one
 * lower-cased key is correct for all three. A quoted identifier whose case
 * differs from the discovered object therefore still resolves to the same key.
 */
export function databaseObjectKey(schema: string, table: string): string {
  return `${schema.trim().toLowerCase()}.${table.trim().toLowerCase()}`;
}

/**
 * Fold flat column rows (schema, table, column, type) into bounded discovered
 * objects. Shared by all three drivers so their caps and ordering agree.
 */
export function foldDiscoveredColumns(
  rows: ReadonlyArray<{ schema: unknown; table: unknown; column: unknown; dataType: unknown }>,
  limits: { maxSchemas?: number; maxTables?: number; maxColumns?: number } = {},
): { objects: Array<{ schema: string; table: string; columns: Array<{ name: string; dataType: string }> }>; truncated: boolean } {
  const maxSchemas = limits.maxSchemas ?? MAX_DISCOVERED_SCHEMAS;
  const maxTables = limits.maxTables ?? MAX_DISCOVERED_TABLES;
  const maxColumns = limits.maxColumns ?? MAX_DISCOVERED_COLUMNS;
  const byTable = new Map<string, { schema: string; table: string; columns: Array<{ name: string; dataType: string }> }>();
  const schemas = new Set<string>();
  let truncated = false;
  let columnCount = 0;

  for (const row of rows) {
    const schema = typeof row.schema === "string" ? row.schema : "";
    const table = typeof row.table === "string" ? row.table : "";
    const column = typeof row.column === "string" ? row.column : "";
    const dataType = typeof row.dataType === "string" ? row.dataType : "";
    if (!schema || !table || !column) continue;
    if (columnCount >= maxColumns) {
      truncated = true;
      break;
    }
    const key = databaseObjectKey(schema, table);
    let entry = byTable.get(key);
    if (!entry) {
      if (!schemas.has(schema) && schemas.size >= maxSchemas) {
        truncated = true;
        continue;
      }
      if (byTable.size >= maxTables) {
        truncated = true;
        continue;
      }
      entry = { schema, table, columns: [] };
      byTable.set(key, entry);
      schemas.add(schema);
    }
    entry.columns.push({ name: column, dataType });
    columnCount += 1;
  }

  return { objects: [...byTable.values()], truncated };
}

/**
 * Classify a connection/query failure for the discovery record. Raw driver
 * exceptions can carry connection strings and row data, so only a stable code
 * and a bounded first-line excerpt are ever persisted.
 */
export function discoveryFailureDetail(error: unknown): { code: string; message: string } {
  if (error instanceof DatabaseExecutorError) {
    return {
      code: error.code ?? error.category,
      message: boundedFirstLine(error.message),
    };
  }
  return { code: "discovery-failed", message: boundedFirstLine(error instanceof Error ? error.message : "") };
}

function boundedFirstLine(value: string): string {
  return (value.split("\n")[0] ?? "").trim().slice(0, 200);
}

/**
 * Certificate-verification failures deserve a specific, actionable message:
 * the tester's remedy is a deliberate setting, never an automatic downgrade.
 */
const CERTIFICATE_ERROR_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

export const CERTIFICATE_VERIFICATION_MESSAGE =
  "The database TLS certificate could not be verified. If this test environment uses a self-signed certificate, enable \"Allow encrypted connection without certificate verification\" under Advanced options in the environment.";

export function certificateFailureMessage(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (!(current instanceof Error)) break;
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string" && CERTIFICATE_ERROR_CODES.has(code)) return CERTIFICATE_VERIFICATION_MESSAGE;
    if (/certificate|self[- ]signed|cert chain|altname/i.test(current.message)) return CERTIFICATE_VERIFICATION_MESSAGE;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return null;
}
