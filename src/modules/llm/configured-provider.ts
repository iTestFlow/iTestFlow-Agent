import "server-only";

import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TRUNCATION_ATTEMPTS,
  DEFAULT_RETRY_ATTEMPTS,
  normalizeLLMControlSettings,
} from "./llm-defaults";
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
      maxOutputTokenCap: runtimeSettings.llm.maxOutputTokenCap,
      retryAttempts: runtimeSettings.llm.retryAttempts,
      maxTruncationAttempts: runtimeSettings.llm.maxTruncationAttempts,
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
        : provider === "anthropic"
          ? process.env.ANTHROPIC_MODEL
          : process.env.OLLAMA_MODEL;

  if (!model) return null;

  const llmControls = normalizeLLMControlSettings({
    maxTokens: process.env.LLM_MAX_TOKENS ?? DEFAULT_MAX_TOKENS,
    maxOutputTokenCap: process.env.LLM_MAX_OUTPUT_TOKEN_CAP ?? DEFAULT_MAX_OUTPUT_TOKEN_CAP,
    retryAttempts: process.env.LLM_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS,
    maxTruncationAttempts: process.env.LLM_MAX_TRUNCATION_ATTEMPTS ?? DEFAULT_MAX_TRUNCATION_ATTEMPTS,
  });

  return createLLMProvider({
    provider,
    apiKey,
    model,
    baseUrl:
      provider === "openai"
        ? process.env.OPENAI_BASE_URL
        : provider === "gemini"
          ? process.env.GEMINI_BASE_URL
          : provider === "anthropic"
            ? process.env.ANTHROPIC_BASE_URL
            : process.env.OLLAMA_BASE_URL,
    temperature: Number(process.env.LLM_TEMPERATURE ?? "0.2"),
    ...llmControls,
  });
}
