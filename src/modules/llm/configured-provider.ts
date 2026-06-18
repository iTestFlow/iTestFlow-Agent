import "server-only";

import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
import {
  DEFAULT_MAX_OUTPUT_TOKEN_CAP,
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
      maxOutputTokenCap: runtimeSettings.llm.maxOutputTokenCap,
      retryAttempts: runtimeSettings.llm.retryAttempts,
    });
  }

  const provider = process.env.DEFAULT_LLM_PROVIDER as LLMProviderName | undefined;
  if (!provider) return null;

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : provider === "gemini"
        ? process.env.GEMINI_API_KEY
        : process.env.ANTHROPIC_API_KEY;

  const model =
    provider === "openai"
      ? process.env.OPENAI_MODEL
      : provider === "gemini"
        ? process.env.GEMINI_MODEL
        : process.env.ANTHROPIC_MODEL;

  if (!model) return null;

  const llmControls = normalizeLLMControlSettings({
    maxOutputTokenCap: process.env.LLM_MAX_OUTPUT_TOKEN_CAP ?? DEFAULT_MAX_OUTPUT_TOKEN_CAP,
    retryAttempts: process.env.LLM_RETRY_ATTEMPTS ?? DEFAULT_RETRY_ATTEMPTS,
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
          : process.env.ANTHROPIC_BASE_URL,
    ...llmControls,
  });
}
