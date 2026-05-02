import "server-only";

import { z } from "zod";
import { LLMProviderNameSchema } from "@/modules/settings/runtime-settings.schema";

export const ListLLMModelsInputSchema = z.object({
  provider: LLMProviderNameSchema,
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});

export type LLMModelOption = {
  id: string;
  displayName: string;
  source: "openai" | "gemini" | "anthropic";
};

export async function listLLMModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  switch (input.provider) {
    case "openai":
      return listOpenAIModels(input);
    case "gemini":
      return listGeminiModels(input);
    case "anthropic":
      return listAnthropicModels(input);
  }
}

async function listOpenAIModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  const response = await fetch(`${input.baseUrl ?? "https://api.openai.com/v1"}/models`, {
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
    },
  });
  if (!response.ok) throw new Error(`OpenAI model fetch failed: ${await response.text()}`);

  const json = (await response.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? [])
    .map((model) => model.id)
    .filter((id): id is string => Boolean(id))
    .sort(sortModelIds)
    .map((id) => ({ id, displayName: id, source: "openai" }));
}

async function listGeminiModels(input: z.infer<typeof ListLLMModelsInputSchema>): Promise<LLMModelOption[]> {
  const baseUrl = input.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const models: LLMModelOption[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      pageSize: "1000",
      key: input.apiKey,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetch(`${baseUrl}/models?${params.toString()}`);
    if (!response.ok) throw new Error(`Gemini model fetch failed: ${await response.text()}`);

    const json = (await response.json()) as {
      models?: Array<{
        name?: string;
        baseModelId?: string;
        displayName?: string;
      }>;
      nextPageToken?: string;
    };

    models.push(
      ...(json.models ?? []).flatMap((model): LLMModelOption[] => {
        const id = model.name?.replace(/^models\//, "") ?? model.baseModelId;
        if (!id) return [];
        return [{
          id,
          displayName: model.displayName ? `${model.displayName} (${id})` : id,
          source: "gemini",
        }];
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

    const response = await fetch(`${anthropicModelsBaseUrl(input.baseUrl)}/models?${params.toString()}`, {
      headers: {
        "x-api-key": input.apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!response.ok) throw new Error(`Anthropic model fetch failed: ${await response.text()}`);

    const json = (await response.json()) as {
      data?: Array<{ id?: string; display_name?: string }>;
      has_more?: boolean;
      last_id?: string | null;
    };

    models.push(
      ...(json.data ?? []).flatMap((model): LLMModelOption[] => {
        if (!model.id) return [];
        return [{
          id: model.id,
          displayName: model.display_name ? `${model.display_name} (${model.id})` : model.id,
          source: "anthropic",
        }];
      }),
    );
    afterId = json.has_more && json.last_id ? json.last_id : undefined;
  } while (afterId);

  return uniqueModels(models);
}

function anthropicModelsBaseUrl(baseUrl?: string) {
  const root = (baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

function uniqueModels(models: LLMModelOption[]) {
  return Array.from(new Map(models.map((model) => [model.id, model])).values());
}

function sortModelIds(a: string, b: string) {
  return a.localeCompare(b);
}
