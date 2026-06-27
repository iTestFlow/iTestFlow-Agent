import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { getWorkspaceSettings, upsertWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv, MAX_OUTPUT_TOKEN_CAP_OPTIONS, RETRY_ATTEMPT_OPTIONS } from "@/modules/llm/llm-defaults";
import { getRetrievalTopKFromEnv, TOP_K_MAX, TOP_K_MIN } from "@/modules/rag/retrieval-config";
import {
  defaultReviewBaselines,
  defaultWorkflowBaselines,
  PUBLISH_WORKFLOW_TYPES,
  workflowLabels,
  workflowTypeValues,
} from "@/modules/analytics/analytics-config";

export const runtime = "nodejs";

/**
 * Workspace-wide settings (owner/admin only): retrieval breadth (top-K) and the
 * LLM max output token cap. A null value means "inherit the deployment default".
 * Members get 403, so the client card hides for them. All access is keyed by the
 * server-resolved workspace.
 */
const allowedCaps = MAX_OUTPUT_TOKEN_CAP_OPTIONS as readonly number[];
const allowedRetries = RETRY_ATTEMPT_OPTIONS as readonly number[];

// Partial per-workflow map of minutes; null clears all overrides (inherit defaults).
const baselineMapSchema = z
  .record(z.enum(workflowTypeValues), z.number().int().min(0).max(100_000))
  .nullable()
  .optional();

const Schema = z
  .object({
    retrievalTopK: z.number().int().min(TOP_K_MIN).max(TOP_K_MAX).nullable().optional(),
    maxOutputTokenCap: z
      .number()
      .int()
      .refine((value) => allowedCaps.includes(value), {
        message: `LLM output cap must be one of ${MAX_OUTPUT_TOKEN_CAP_OPTIONS.join(", ")}.`,
      })
      .nullable()
      .optional(),
    llmRetryAttempts: z
      .number()
      .int()
      .refine((value) => allowedRetries.includes(value), {
        message: `LLM retry attempts must be one of ${RETRY_ATTEMPT_OPTIONS.join(", ")}.`,
      })
      .nullable()
      .optional(),
    manualBaselineMinutes: baselineMapSchema,
    reviewBaselineMinutes: baselineMapSchema,
  })
  .refine(
    (value) =>
      value.retrievalTopK !== undefined ||
      value.maxOutputTokenCap !== undefined ||
      value.llmRetryAttempts !== undefined ||
      value.manualBaselineMinutes !== undefined ||
      value.reviewBaselineMinutes !== undefined,
    { message: "Provide a setting to update." },
  );

function defaultsPayload() {
  return {
    retrievalTopKDefault: getRetrievalTopKFromEnv(),
    maxOutputTokenCapDefault: getMaxOutputTokenCapDefaultFromEnv(),
    maxOutputTokenCapOptions: MAX_OUTPUT_TOKEN_CAP_OPTIONS,
    topKMin: TOP_K_MIN,
    topKMax: TOP_K_MAX,
    retryAttemptsDefault: DEFAULT_RETRY_ATTEMPTS,
    retryAttemptsOptions: RETRY_ATTEMPT_OPTIONS,
    workflowTypes: workflowTypeValues,
    workflowLabels,
    manualBaselineDefaults: defaultWorkflowBaselines,
    reviewBaselineDefaults: defaultReviewBaselines,
    perItemReviewTypes: PUBLISH_WORKFLOW_TYPES,
  };
}

export async function GET() {
  let context: Awaited<ReturnType<typeof resolveWorkspaceRequest>>;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const settings = await getWorkspaceSettings(context.workspace.id);
  return NextResponse.json(
    {
      workspaceId: context.workspace.id,
      settings: settings ?? {
        retrievalTopK: null,
        maxOutputTokenCap: null,
        llmRetryAttempts: null,
        manualBaselineMinutes: null,
        reviewBaselineMinutes: null,
      },
      defaults: defaultsPayload(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  let context: Awaited<ReturnType<typeof resolveWorkspaceRequest>>;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid workspace settings." },
      { status: 400 },
    );
  }

  const settings = await upsertWorkspaceSettings({
    workspaceId: context.workspace.id,
    retrievalTopK: parsed.data.retrievalTopK,
    maxOutputTokenCap: parsed.data.maxOutputTokenCap,
    llmRetryAttempts: parsed.data.llmRetryAttempts,
    manualBaselineMinutes: parsed.data.manualBaselineMinutes,
    reviewBaselineMinutes: parsed.data.reviewBaselineMinutes,
    updatedByUserId: context.userId,
  });

  return NextResponse.json({ workspaceId: context.workspace.id, settings, defaults: defaultsPayload() });
}
