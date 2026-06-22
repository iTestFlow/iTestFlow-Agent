import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { getWorkspaceSettings, upsertWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv, MAX_OUTPUT_TOKEN_CAP_OPTIONS, RETRY_ATTEMPT_OPTIONS } from "@/modules/llm/llm-defaults";
import { getRetrievalTopKFromEnv, TOP_K_MAX, TOP_K_MIN } from "@/modules/rag/retrieval-config";

export const runtime = "nodejs";

/**
 * Workspace-wide settings (owner/admin only): retrieval breadth (top-K) and the
 * LLM max output token cap. A null value means "inherit the deployment default".
 * Members get 403, so the client card hides for them. All access is keyed by the
 * server-resolved workspace.
 */
const allowedCaps = MAX_OUTPUT_TOKEN_CAP_OPTIONS as readonly number[];
const allowedRetries = RETRY_ATTEMPT_OPTIONS as readonly number[];

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
  })
  .refine(
    (value) =>
      value.retrievalTopK !== undefined ||
      value.maxOutputTokenCap !== undefined ||
      value.llmRetryAttempts !== undefined,
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
      settings: settings ?? { retrievalTopK: null, maxOutputTokenCap: null, llmRetryAttempts: null },
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
    updatedByUserId: context.userId,
  });

  return NextResponse.json({ workspaceId: context.workspace.id, settings, defaults: defaultsPayload() });
}
