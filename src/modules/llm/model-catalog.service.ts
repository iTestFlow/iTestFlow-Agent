import "server-only";

import { z } from "zod";
import type { LLMProviderName } from "./llm-types";
import { normalizeProviderBaseUrl } from "./provider-base-url";
import { AppError, AppErrorCode, isAppError } from "@/modules/shared/errors/app-error";
import { friendlyErrorMessage } from "@/modules/shared/errors/error-response";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export const LLMProviderNameSchema = z.enum(["openai", "gemini", "anthropic"]);

export const ListLLMModelsInputSchema = z.object({
  provider: LLMProviderNameSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});

export type LLMModelOption = {
  id: string;
  displayName: string;
  source: LLMProviderName;
};

export async function listLLMModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  try {
    switch (input.provider) {
      case "openai":   return await listOpenAIModels(input);
      case "gemini":   return await listGeminiModels(input);
      case "anthropic": return await listAnthropicModels(input);
    }
  } catch (error) {
    if (isAppError(error)) throw error;
    const userMessage = friendlyErrorMessage(error, { domain: "llm", provider: input.provider });
    throw new AppError({
      code: AppErrorCode.Network,
      message: userMessage,
      userMessage,
      technicalContext: {
        provider: input.provider,
        upstreamCause: error instanceof Error ? error.message : undefined,
      },
    });
  }
}

async function listOpenAIModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  const response = await fetch(`${input.baseUrl ?? "https://api.openai.com/v1"}/models`, {
    headers: { Authorization: `Bearer ${input.apiKey}` },
  });
  if (!response.ok) throw await modelFetchError("openai", response);
  const json = (await response.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id))
    .sort(sortModelIds)
    .map((id) => ({ id, displayName: id, source: "openai" as const }));
}

async function listGeminiModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  const baseUrl = input.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const models: LLMModelOption[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({ pageSize: "1000", key: input.apiKey });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`${baseUrl}/models?${params.toString()}`);
    if (!response.ok) throw await modelFetchError("gemini", response);
    const json = (await response.json()) as {
      models?: Array<{ name?: string; baseModelId?: string; displayName?: string }>;
      nextPageToken?: string;
    };
    models.push(
      ...(json.models ?? []).flatMap((m): LLMModelOption[] => {
        const id = m.name?.replace(/^models\//, "") ?? m.baseModelId;
        if (!id) return [];
        return [{ id, displayName: m.displayName ? `${m.displayName} (${id})` : id, source: "gemini" }];
      }),
    );
    pageToken = json.nextPageToken;
  } while (pageToken);

  return uniqueModels(models).sort((a, b) => sortModelIds(a.id, b.id));
}

async function listAnthropicModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  const models: LLMModelOption[] = [];
  let afterId: string | undefined;

  do {
    const params = new URLSearchParams({ limit: "1000" });
    if (afterId) params.set("after_id", afterId);
    const response = await fetch(
      `${normalizeProviderBaseUrl(input.baseUrl, ANTHROPIC_DEFAULT_BASE_URL, { requiredPath: "/v1" })}/models?${params.toString()}`,
      { headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" } },
    );
    if (!response.ok) throw await modelFetchError("anthropic", response);
    const json = (await response.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
      has_more?: boolean;
      last_id?: string | null;
    };
    models.push(
      ...(json.data ?? []).flatMap((m): LLMModelOption[] => {
        if (!m.id) return [];
        return [{ id: m.id, displayName: m.display_name ? `${m.display_name} (${m.id})` : m.id, source: "anthropic" }];
      }),
    );
    afterId = json.has_more && json.last_id ? json.last_id : undefined;
  } while (afterId);

  return uniqueModels(models);
}

function uniqueModels(models: LLMModelOption[]) {
  return Array.from(new Map(models.map((m) => [m.id, m])).values());
}

function sortModelIds(a: string, b: string) {
  return a.localeCompare(b);
}

async function modelFetchError(provider: LLMProviderName, response: Response) {
  const body = await response.text().catch(() => "");
  const message = `${provider} model list request failed (${response.status}): ${body}`;
  const userMessage = friendlyErrorMessage(new Error(message), {
    domain: "llm",
    provider,
    status: response.status,
  });
  return new AppError({
    code: AppErrorCode.ProviderUnavailable,
    message: userMessage,
    userMessage,
    technicalContext: {
      provider,
      rawOutputExcerpt: body,
    },
  });
}
