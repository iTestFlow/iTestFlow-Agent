import "server-only";

import {
  defaultReviewBaselines,
  defaultWorkflowBaselines,
  isPerItemReview,
  workflowTypeValues,
  type WorkflowType,
} from "@/modules/analytics/analytics-config";
import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * Per-workspace overrides for retrieval breadth (top-K), the LLM max output token
 * cap, retry attempts, and the value-metrics baselines (manual effort + review
 * effort per workflow). A null field means "inherit the deployment default" —
 * consumers (retrieval-config, scoped-resolution, analytics) apply their own
 * fallback. One row per workspace, keyed directly by workspace_id. All persistence
 * is keyed by the server-resolved workspace id, never client input.
 */
export type WorkflowBaselineMap = Partial<Record<WorkflowType, number>>;

export type WorkspaceSettingsView = {
  retrievalTopK: number | null;
  maxOutputTokenCap: number | null;
  llmRetryAttempts: number | null;
  manualBaselineMinutes: WorkflowBaselineMap | null;
  reviewBaselineMinutes: WorkflowBaselineMap | null;
};

type WorkspaceSettingsRow = {
  retrieval_top_k: number | null;
  max_output_token_cap: number | null;
  llm_retry_attempts: number | null;
  manual_baseline_minutes: unknown;
  review_baseline_minutes: unknown;
};

// jsonb is auto-parsed to an object by the pg driver, but tolerate a raw JSON
// string defensively. Keep only known workflow keys with finite, non-negative
// minutes so a malformed/stale override can never poison a calculation.
function parseBaselineMap(value: unknown): WorkflowBaselineMap | null {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object" || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const result: WorkflowBaselineMap = {};
  for (const type of workflowTypeValues) {
    const minutes = source[type];
    if (typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0) {
      result[type] = minutes;
    }
  }
  return Object.keys(result).length ? result : null;
}

function toView(row: WorkspaceSettingsRow): WorkspaceSettingsView {
  return {
    retrievalTopK: row.retrieval_top_k,
    maxOutputTokenCap: row.max_output_token_cap,
    llmRetryAttempts: row.llm_retry_attempts,
    manualBaselineMinutes: parseBaselineMap(row.manual_baseline_minutes),
    reviewBaselineMinutes: parseBaselineMap(row.review_baseline_minutes),
  };
}

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsView | null> {
  const row = await sqlGet<WorkspaceSettingsRow>(
    `SELECT retrieval_top_k, max_output_token_cap, llm_retry_attempts,
            manual_baseline_minutes, review_baseline_minutes
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
  manualBaselineMinutes?: WorkflowBaselineMap | null;
  reviewBaselineMinutes?: WorkflowBaselineMap | null;
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
  const manualBaselineMinutes =
    input.manualBaselineMinutes !== undefined ? input.manualBaselineMinutes : existing?.manualBaselineMinutes ?? null;
  const reviewBaselineMinutes =
    input.reviewBaselineMinutes !== undefined ? input.reviewBaselineMinutes : existing?.reviewBaselineMinutes ?? null;
  // Nullable params are ::int / ::text / ::jsonb cast so Postgres can infer the
  // column type when the value is NULL (a bare named param has no inferable type).
  await sqlRun(
    `INSERT INTO workspace_settings
       (workspace_id, retrieval_top_k, max_output_token_cap, llm_retry_attempts,
        manual_baseline_minutes, review_baseline_minutes,
        updated_by_user_id, created_at, updated_at)
     VALUES
       (@workspaceId, @retrievalTopK::int, @maxOutputTokenCap::int, @llmRetryAttempts::int,
        @manualBaselineMinutes::jsonb, @reviewBaselineMinutes::jsonb,
        @updatedByUserId::text, @now, @now)
     ON CONFLICT (workspace_id) DO UPDATE SET
       retrieval_top_k         = excluded.retrieval_top_k,
       max_output_token_cap    = excluded.max_output_token_cap,
       llm_retry_attempts      = excluded.llm_retry_attempts,
       manual_baseline_minutes = excluded.manual_baseline_minutes,
       review_baseline_minutes = excluded.review_baseline_minutes,
       updated_by_user_id      = excluded.updated_by_user_id,
       updated_at              = excluded.updated_at`,
    {
      workspaceId: input.workspaceId,
      retrievalTopK,
      maxOutputTokenCap,
      llmRetryAttempts,
      manualBaselineMinutes: manualBaselineMinutes ? JSON.stringify(manualBaselineMinutes) : null,
      reviewBaselineMinutes: reviewBaselineMinutes ? JSON.stringify(reviewBaselineMinutes) : null,
      updatedByUserId: input.updatedByUserId,
      now,
    },
  );
  const view = await getWorkspaceSettings(input.workspaceId);
  // Just upserted — always present; fall back to the resolved shape defensively.
  return (
    view ?? {
      retrievalTopK,
      maxOutputTokenCap,
      llmRetryAttempts,
      manualBaselineMinutes,
      reviewBaselineMinutes,
    }
  );
}

/**
 * Resolve the manual-effort baseline (M, minutes) for a workflow: the workspace
 * override when present, else the deployment default. Used by analytics at run start.
 */
export async function resolveWorkflowBaseline(
  workspaceId: string | null | undefined,
  type: WorkflowType,
): Promise<number> {
  if (workspaceId) {
    const settings = await getWorkspaceSettings(workspaceId);
    const override = settings?.manualBaselineMinutes?.[type];
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) return override;
  }
  return defaultWorkflowBaselines[type];
}

/**
 * Resolve the human review-effort estimate (R, minutes) for a completed run.
 * The configured/default value is interpreted as minutes-per-item for generative
 * workflows (multiplied by itemCount) and minutes-per-run otherwise.
 */
export async function resolveReviewBaseline(
  workspaceId: string | null | undefined,
  type: WorkflowType,
  itemCount: number,
): Promise<number> {
  let perUnit = defaultReviewBaselines[type];
  if (workspaceId) {
    const settings = await getWorkspaceSettings(workspaceId);
    const override = settings?.reviewBaselineMinutes?.[type];
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) perUnit = override;
  }
  return isPerItemReview(type) ? perUnit * Math.max(itemCount, 0) : perUnit;
}
