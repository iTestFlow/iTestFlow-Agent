import "server-only";

import { createId, nowIso, sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { sanitizeExecutionError, sanitizeExecutionPayload } from "./execution-redaction";

export type ExecutionOperation = {
  id: string;
  caseId: string;
  stepId: string;
  connectionAlias: string | null;
  operation: string;
  status: "running" | "completed" | "failed" | "uncertain";
  evidence: unknown;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

type OperationRow = {
  id: string; case_id: string; step_id: string; connection_alias: string | null;
  operation: string; status: ExecutionOperation["status"]; evidence_json: unknown;
  error_message: string | null; started_at: string; finished_at: string | null; duration_ms: number | null;
};

/** Returns null when worker no longer owns run job. Call before external dispatch. */
export async function startOperation(input: {
  runId: string;
  caseId: string;
  stepId: string;
  workerId: string;
  connectionAlias?: string | null;
  operation: string;
  secrets?: readonly string[];
}): Promise<string | null> {
  const id = createId("pwop");
  const row = await sqlGet<{ id: string }>(
    `INSERT INTO playwright_execution_operations
      (id, run_id, case_id, step_id, connection_alias, operation, status, started_at)
     SELECT @id, r.id, c.id, s.id, @alias, @operation, 'running', @now
       FROM playwright_execution_runs r
       JOIN playwright_execution_cases c ON c.run_id = r.id AND c.id = @caseId
       JOIN playwright_execution_steps s ON s.case_id = c.id AND s.id = @stepId
       JOIN jobs j ON j.id = r.job_id
      WHERE r.id = @runId AND r.status = 'running' AND j.status = 'running' AND j.locked_by = @workerId
     RETURNING id`,
    { id, runId: input.runId, caseId: input.caseId, stepId: input.stepId, alias: input.connectionAlias ?? null,
      operation: sanitizeExecutionError(input.operation, input.secrets ?? []).slice(0, 200), now: nowIso(), workerId: input.workerId },
  );
  return row?.id ?? null;
}

/** Fenced finish; false means lease lost, leaving operation uncertain. */
export async function finishOperation(input: {
  operationId: string;
  workerId: string;
  status: "completed" | "failed" | "uncertain";
  evidence?: unknown;
  errorMessage?: string | null;
  secrets?: readonly string[];
}): Promise<boolean> {
  const now = nowIso();
  const row = await sqlGet<{ id: string }>(
    `UPDATE playwright_execution_operations o
        SET status = @status, evidence_json = @evidence::jsonb, error_message = @error,
            finished_at = @now, duration_ms = GREATEST(0, (EXTRACT(EPOCH FROM ((@now::text)::timestamptz - o.started_at::timestamptz)) * 1000)::integer)
       FROM playwright_execution_runs r JOIN jobs j ON j.id = r.job_id
      WHERE o.id = @operationId AND o.run_id = r.id AND o.status = 'running'
        AND j.status = 'running' AND j.locked_by = @workerId
      RETURNING o.id`,
    { operationId: input.operationId, workerId: input.workerId, status: input.status,
      evidence: JSON.stringify(sanitizeExecutionPayload(input.evidence ?? null, input.secrets ?? [])),
      error: input.errorMessage ? sanitizeExecutionError(input.errorMessage, input.secrets ?? []) : null, now },
  );
  return Boolean(row);
}

export async function listExecutionOperations(runId: string): Promise<ExecutionOperation[]> {
  const rows = await sqlAll<OperationRow>(
    `SELECT id, case_id, step_id, connection_alias, operation, status, evidence_json,
            error_message, started_at, finished_at, duration_ms
       FROM playwright_execution_operations WHERE run_id = @runId ORDER BY started_at, id`, { runId },
  );
  return rows.map((row) => ({ id: row.id, caseId: row.case_id, stepId: row.step_id,
    connectionAlias: row.connection_alias, operation: row.operation, status: row.status,
    evidence: row.evidence_json, errorMessage: row.error_message, startedAt: row.started_at,
    finishedAt: row.finished_at, durationMs: row.duration_ms }));
}
