import "server-only";

import {
  getDefaultReviewBaseline,
  getDefaultWorkflowBaseline,
  isPerItemReview,
  LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW,
  workflowTypeValues,
  type ActiveWorkflowType,
  type WorkflowType,
} from "@/modules/analytics/analytics-config";
import { nowIso, sqlGet } from "@/modules/shared/infrastructure/database/db";

/**
 * Per-workspace overrides for retrieval breadth (top-K), the LLM max output token
 * cap, retry attempts, and the value-metrics baselines (manual effort + review
 * effort per workflow). A null field means "inherit the deployment default" —
 * consumers (retrieval-config, scoped-resolution, analytics) apply their own
 * fallback. One row per workspace, keyed directly by workspace_id. All persistence
 * is keyed by the server-resolved workspace id, never client input.
 */
export type WorkflowBaselineMap = Partial<Record<ActiveWorkflowType, number>>;

export type WorkspaceSettingsView = {
  retrievalTopK: number | null;
  maxOutputTokenCap: number | null;
  modelInputTokenLimitOverride: number | null;
  llmRetryAttempts: number | null;
  externalLlmEnabled: boolean;
  manualBaselineMinutes: WorkflowBaselineMap | null;
  reviewBaselineMinutes: WorkflowBaselineMap | null;
};

export const DEFAULT_EXTERNAL_LLM_ENABLED = true;

type WorkspaceSettingsRow = {
  retrieval_top_k: number | null;
  max_output_token_cap: number | null;
  model_input_token_limit_override: number | null;
  llm_retry_attempts: number | null;
  external_llm_enabled: boolean | null;
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
    modelInputTokenLimitOverride: row.model_input_token_limit_override,
    llmRetryAttempts: row.llm_retry_attempts,
    // The migration is NOT NULL, but only an explicit false should disable
    // External LLM if a malformed legacy row is encountered.
    externalLlmEnabled: row.external_llm_enabled !== false,
    manualBaselineMinutes: parseBaselineMap(row.manual_baseline_minutes),
    reviewBaselineMinutes: parseBaselineMap(row.review_baseline_minutes),
  };
}

export async function getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettingsView | null> {
  const row = await sqlGet<WorkspaceSettingsRow>(
    `SELECT retrieval_top_k, max_output_token_cap, model_input_token_limit_override,
            llm_retry_attempts, external_llm_enabled,
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
  modelInputTokenLimitOverride?: number | null;
  llmRetryAttempts?: number | null;
  externalLlmEnabled?: boolean;
  manualBaselineMinutes?: WorkflowBaselineMap | null;
  reviewBaselineMinutes?: WorkflowBaselineMap | null;
  updatedByUserId: string | null;
}): Promise<WorkspaceSettingsView> {
  const now = nowIso();
  // Omitted fields are absent from the INSERT and conflict UPDATE lists; an
  // explicit null remains a written value for nullable settings.
  const columns = ["workspace_id", "updated_by_user_id", "created_at", "updated_at"];
  const values = ["@workspaceId", "@updatedByUserId::text", "@now", "@now"];
  const updates = ["updated_by_user_id = excluded.updated_by_user_id", "updated_at = excluded.updated_at"];
  const params: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    updatedByUserId: input.updatedByUserId,
    now,
  };

  function addField(column: string, parameter: string, cast: string, value: unknown) {
    columns.push(column);
    values.push(`@${parameter}${cast}`);
    updates.unshift(`${column} = excluded.${column}`);
    params[parameter] = value;
  }

  if (input.retrievalTopK !== undefined) {
    addField("retrieval_top_k", "retrievalTopK", "::int", input.retrievalTopK);
  }
  if (input.maxOutputTokenCap !== undefined) {
    addField("max_output_token_cap", "maxOutputTokenCap", "::int", input.maxOutputTokenCap);
  }
  if (input.modelInputTokenLimitOverride !== undefined) {
    addField(
      "model_input_token_limit_override",
      "modelInputTokenLimitOverride",
      "::int",
      input.modelInputTokenLimitOverride,
    );
  }
  if (input.llmRetryAttempts !== undefined) {
    addField("llm_retry_attempts", "llmRetryAttempts", "::int", input.llmRetryAttempts);
  }
  // When omitted on a newly-created row, the database default remains true.
  if (input.externalLlmEnabled !== undefined) {
    addField("external_llm_enabled", "externalLlmEnabled", "::boolean", input.externalLlmEnabled);
  }
  if (input.manualBaselineMinutes !== undefined) {
    addField(
      "manual_baseline_minutes",
      "manualBaselineMinutes",
      "::jsonb",
      input.manualBaselineMinutes === null ? null : JSON.stringify(input.manualBaselineMinutes),
    );
  }
  if (input.reviewBaselineMinutes !== undefined) {
    addField(
      "review_baseline_minutes",
      "reviewBaselineMinutes",
      "::jsonb",
      input.reviewBaselineMinutes === null ? null : JSON.stringify(input.reviewBaselineMinutes),
    );
  }
  const row = await sqlGet<WorkspaceSettingsRow>(
    `INSERT INTO workspace_settings (${columns.join(", ")})
     VALUES (${values.join(", ")})
     ON CONFLICT (workspace_id) DO UPDATE SET
       ${updates.join(",\n       ")}
     RETURNING retrieval_top_k, max_output_token_cap, model_input_token_limit_override,
               llm_retry_attempts, external_llm_enabled,
               manual_baseline_minutes, review_baseline_minutes`,
    params,
  );
  // INSERT ... RETURNING and ON CONFLICT ... DO UPDATE ... RETURNING both return exactly one row.
  if (!row) throw new Error("Workspace settings upsert did not return a row.");
  return toView(row);
}

/**
 * Resolve the manual-effort baseline (M, minutes) for a workflow: the workspace
 * override when present, else the deployment default. Used by analytics at run start.
 */
export async function resolveWorkflowBaseline(
  workspaceId: string | null | undefined,
  type: WorkflowType,
): Promise<number> {
  if (workspaceId && type !== LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW) {
    const settings = await getWorkspaceSettings(workspaceId);
    const override = settings?.manualBaselineMinutes?.[type];
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) return override;
  }
  return getDefaultWorkflowBaseline(type);
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
  let perUnit = getDefaultReviewBaseline(type);
  if (workspaceId && type !== LEGACY_TEST_EXECUTION_EFFORT_WORKFLOW) {
    const settings = await getWorkspaceSettings(workspaceId);
    const override = settings?.reviewBaselineMinutes?.[type];
    if (typeof override === "number" && Number.isFinite(override) && override >= 0) perUnit = override;
  }
  return isPerItemReview(type) ? perUnit * Math.max(itemCount, 0) : perUnit;
}
