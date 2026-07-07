import "server-only";

import { z } from "zod";
import type { LLMProviderName } from "./llm-types";
import { normalizeProviderBaseUrl } from "./provider-base-url";

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
    if (error instanceof ModelCatalogError) throw error;
    throw new ModelCatalogError(
      `Could not connect to ${providerLabel(input.provider)} to load models. Check your network connection and provider base URL, then try again.`,
    );
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

class ModelCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCatalogError";
  }
}

async function modelFetchError(provider: LLMProviderName, response: Response) {
  const body = await response.text().catch(() => "");
  return new ModelCatalogError(friendlyModelFetchMessage(provider, response.status, body));
}

function friendlyModelFetchMessage(provider: LLMProviderName, status: number, body: string) {
  const label = providerLabel(provider);
  const text = body.toLowerCase();

  if (status === 401 || isAuthenticationError(text)) {
    return `${label} rejected the API key. Check that the key is correct and belongs to ${label}, then try again.`;
  }

  if (status === 403 || text.includes("permission") || text.includes("forbidden")) {
    return `${label} rejected the request. Check that your API key has permission to list models for this provider.`;
  }

  if (status === 429 || text.includes("rate limit") || text.includes("quota") || text.includes("resource_exhausted")) {
    return `${label} could not load models because the provider rate limit or quota was reached. Wait a moment, then try again.`;
  }

  if (status === 404) {
    return `${label} could not find the model-list endpoint. Check the optional provider base URL and try again.`;
  }

  if (status >= 500 || text.includes("overloaded") || text.includes("unavailable")) {
    return `${label} is temporarily unavailable while loading models. Try again in a moment.`;
  }

  return `${label} could not load models. Check the selected provider, API key, and optional base URL, then try again.`;
}

function isAuthenticationError(text: string) {
  return (
    text.includes("api key") ||
    text.includes("x-api-key") ||
    text.includes("invalid_api_key") ||
    text.includes("authentication_error") ||
    text.includes("unauthorized") ||
    text.includes("unauthenticated") ||
    text.includes("invalid_argument")
  );
}

function providerLabel(provider: LLMProviderName) {
  switch (provider) {
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "anthropic":
      return "Anthropic";
  }
}
