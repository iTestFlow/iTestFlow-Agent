import "server-only";

import { createId, enqueueBackgroundWrite, nowIso, sqlRun } from "@/modules/shared/infrastructure/database/db";
import type { LLMProviderName } from "./llm-types";

export type LLMRequestLogMetadata = {
  action?: string;
  promptName?: string;
  promptVersion?: string;
  projectId?: string;
  azureProjectId?: string;
  azureProjectName?: string;
  azureOrganizationUrl?: string;
  targetWorkItemId?: string;
  /**
   * Some workflows send live application data to the model. Those callers can
   * retain request timing/model metadata without duplicating the prompt or
   * provider payload in the audit database.
   */
  logRetention?: "full" | "metadata_only";
};

export type LLMRequestLogInput = LLMRequestLogMetadata & {
  provider: LLMProviderName;
  model: string;
  schemaName: string;
  systemPrompt: string;
  userPrompt: string;
  requestBody?: unknown;
  responseBody?: unknown;
  rawOutput?: string;
  validatedOutput?: unknown;
  status: "Success" | "Failed";
  errorDetails?: string;
  durationMs: number;
};

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|token|pat|password|secret|x-api-key|personalAccessToken)/i;

export function writeLLMRequestLog(input: LLMRequestLogInput) {
  const now = nowIso();
  const retained = applyLLMLogRetention(input);
  const params = {
    id: createId("llmreq"),
    projectId: input.projectId ?? null,
    azureProjectId: input.azureProjectId ?? null,
    azureProjectName: input.azureProjectName ?? null,
    azureOrganizationUrl: input.azureOrganizationUrl ?? null,
    targetWorkItemId: input.targetWorkItemId ?? null,
    action: input.action ?? null,
    provider: input.provider,
    model: input.model,
    schemaName: input.schemaName,
    promptName: input.promptName ?? null,
    promptVersion: input.promptVersion ?? null,
    systemPrompt: retained.systemPrompt,
    userPrompt: retained.userPrompt,
    requestBodyJson: stringifyForLog(retained.requestBody),
    responseBodyJson: stringifyForLog(retained.responseBody),
    rawOutput: retained.rawOutput ?? null,
    validatedOutputJson: stringifyForLog(retained.validatedOutput),
    status: input.status,
    errorDetails: retained.errorDetails ?? null,
    durationMs: input.durationMs,
    createdAt: now,
    updatedAt: now,
  };

  enqueueBackgroundWrite(`llm-request:${input.schemaName}`, () =>
    sqlRun(
      `INSERT INTO llm_request_logs (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        target_work_item_id, action, provider, model_name, schema_name,
        prompt_name, prompt_version, system_prompt, user_prompt, request_body_json,
        response_body_json, raw_output, validated_output_json, status, error_details,
        duration_ms, created_at, updated_at
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @targetWorkItemId, @action, @provider, @model, @schemaName,
        @promptName, @promptVersion, @systemPrompt, @userPrompt, @requestBodyJson,
        @responseBodyJson, @rawOutput, @validatedOutputJson, @status, @errorDetails,
        @durationMs, @createdAt, @updatedAt
      )`,
      params,
    ),
  );
}

const METADATA_ONLY_MARKER = "[REDACTED: metadata-only retention]";

export function applyLLMLogRetention(input: Pick<
  LLMRequestLogInput,
  | "logRetention"
  | "systemPrompt"
  | "userPrompt"
  | "requestBody"
  | "responseBody"
  | "rawOutput"
  | "validatedOutput"
  | "errorDetails"
>) {
  if (input.logRetention !== "metadata_only") {
    return {
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      requestBody: input.requestBody,
      responseBody: input.responseBody,
      rawOutput: input.rawOutput,
      validatedOutput: input.validatedOutput,
      errorDetails: input.errorDetails,
    };
  }
  return {
    systemPrompt: METADATA_ONLY_MARKER,
    userPrompt: METADATA_ONLY_MARKER,
    requestBody: undefined,
    responseBody: undefined,
    rawOutput: undefined,
    validatedOutput: undefined,
    // Provider errors can echo request fragments or model output. Status and
    // duration remain sufficient metadata for this retention mode.
    errorDetails: undefined,
  };
}

export function sanitizeLLMLogPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeLLMLogPayload(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : sanitizeLLMLogPayload(entry),
    ]),
  );
}

function stringifyForLog(value: unknown) {
  if (value === undefined) return null;
  try {
    return JSON.stringify(sanitizeLLMLogPayload(value));
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}
