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
