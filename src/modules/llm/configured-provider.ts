import "server-only";

import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import { createLLMProvider } from "./llm-provider.factory";
import type { LLMProvider, LLMProviderName } from "./llm-types";

export function getConfiguredProviderFromEnv(): LLMProvider | null {
  const runtimeSettings = getEffectiveRuntimeSettings();
  if (runtimeSettings) {
    return createLLMProvider({
      provider: runtimeSettings.llm.provider,
      apiKey: runtimeSettings.llm.apiKey,
      model: runtimeSettings.llm.model,
      baseUrl: runtimeSettings.llm.baseUrl,
      temperature: runtimeSettings.llm.temperature,
      maxTokens: runtimeSettings.llm.maxTokens,
    });
  }

  const provider = process.env.DEFAULT_LLM_PROVIDER as LLMProviderName | undefined;
  if (!provider) return null;

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : provider === "gemini"
        ? process.env.GEMINI_API_KEY
        : provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY
          : undefined;

  const model =
    provider === "openai"
      ? process.env.OPENAI_MODEL
      : provider === "gemini"
        ? process.env.GEMINI_MODEL
      : process.env.ANTHROPIC_MODEL;

  if (!model) return null;

  return createLLMProvider({
    provider,
    apiKey,
    model,
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
    maxTokens: Number(process.env.LLM_MAX_TOKENS ?? "4000"),
  });
}
