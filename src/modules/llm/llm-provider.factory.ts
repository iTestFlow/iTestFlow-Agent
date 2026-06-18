import "server-only";

import type { LLMProvider, LLMProviderConfig } from "./llm-types";
import { AnthropicProvider } from "./providers/anthropic-provider";
import { GeminiProvider } from "./providers/gemini-provider";
import { OpenAIProvider } from "./providers/openai-provider";

export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.provider) {
    case "openai":
      return new OpenAIProvider(config);
    case "gemini":
      return new GeminiProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    default:
      throw new Error(`Unsupported LLM provider: ${(config as { provider: string }).provider}`);
  }
}
