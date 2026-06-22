import "server-only";

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * Per-workspace overrides for retrieval breadth (top-K) and the LLM max output
 * token cap. A null field means "inherit the deployment default" — consumers
 * (retrieval-config, scoped-resolution) apply their own fallback + clamping. One
 * row per workspace, keyed directly by workspace_id. All persistence is keyed by
 * the server-resolved workspace id, never client input.
 */
export type WorkspaceSettingsView = {
  retrievalTopK: number | null;
  maxOutputTokenCap: number | null;
  llmRetryAttempts: number | null;
};

type WorkspaceSettingsRow = {
  retrieval_top_k: number | null;
  max_output_token_cap: number | null;
  llm_retry_attempts: number | null;
};

function toView(row: WorkspaceSettingsRow): WorkspaceSettingsView {
  return {
    retrievalTopK: row.retrieval_top_k,
    maxOutputTokenCap: row.max_output_token_cap,
    llmRetryAttempts: row.llm_retry_attempts,
  };
}

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsView | null> {
  const row = await sqlGet<WorkspaceSettingsRow>(
    `SELECT retrieval_top_k, max_output_token_cap, llm_retry_attempts
       FROM workspace_settings
      WHERE workspace_id = @workspaceId
      LIMIT 1`,
    { workspaceId },
  );
  return row ? toView(row) : null;
}

export async function upsertWorkspaceSettings(input: {
  workspaceId: string;
  retrievalTopK?: number | null;
  maxOutputTokenCap?: number | null;
  llmRetryAttempts?: number | null;
  updatedByUserId: string | null;
}): Promise<WorkspaceSettingsView> {
  const now = nowIso();
  // Partial update: an omitted field (undefined) keeps the current value; an
  // explicit null clears the override (inherit the default). Read-modify-write so
  // settings split across UI tabs don't clobber each other.
  const existing = await getWorkspaceSettings(input.workspaceId);
  const retrievalTopK = input.retrievalTopK !== undefined ? input.retrievalTopK : existing?.retrievalTopK ?? null;
  const maxOutputTokenCap =
    input.maxOutputTokenCap !== undefined ? input.maxOutputTokenCap : existing?.maxOutputTokenCap ?? null;
  const llmRetryAttempts =
    input.llmRetryAttempts !== undefined ? input.llmRetryAttempts : existing?.llmRetryAttempts ?? null;
  // Nullable params are ::int / ::text cast so Postgres can infer the column type
  // when the value is NULL (a bare named param has no inferable type).
  await sqlRun(
    `INSERT INTO workspace_settings
       (workspace_id, retrieval_top_k, max_output_token_cap, llm_retry_attempts, updated_by_user_id, created_at, updated_at)
     VALUES
       (@workspaceId, @retrievalTopK::int, @maxOutputTokenCap::int, @llmRetryAttempts::int, @updatedByUserId::text, @now, @now)
     ON CONFLICT (workspace_id) DO UPDATE SET
       retrieval_top_k      = excluded.retrieval_top_k,
       max_output_token_cap = excluded.max_output_token_cap,
       llm_retry_attempts   = excluded.llm_retry_attempts,
       updated_by_user_id   = excluded.updated_by_user_id,
       updated_at           = excluded.updated_at`,
    {
      workspaceId: input.workspaceId,
      retrievalTopK,
      maxOutputTokenCap,
      llmRetryAttempts,
      updatedByUserId: input.updatedByUserId,
      now,
    },
  );
  const view = await getWorkspaceSettings(input.workspaceId);
  // Just upserted — always present; fall back to the resolved shape defensively.
  return view ?? { retrievalTopK, maxOutputTokenCap, llmRetryAttempts };
}
