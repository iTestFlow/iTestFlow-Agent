import "server-only";

import { z } from "zod";
import { DEFAULT_TEXT_OUTPUT_TOKENS, DEFAULT_RETRY_ATTEMPTS } from "../llm-defaults";
import { withStructuredOutputInstruction } from "../prompts";
import { normalizeProviderBaseUrl } from "../provider-base-url";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import { fetchWithTransientRetry } from "./fetch-with-transient-retry";
import type { GenerateStructuredOutputInput, GenerateTextInput } from "../llm-types";

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export class AnthropicProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const response = await fetch(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "Return ok." }],
      }),
    });
    return response.ok;
  }

  protected async callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Anthropic API key is not configured.");
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    };
    const response = await fetchWithTransientRetry(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    }, this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "",
        requestBody,
        responseBody: errorText,
        errorMessage: `Anthropic request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.content?.[0]?.text ?? "",
      requestBody,
      responseBody: json,
      finishReason: json.stop_reason,
      tokenUsage: anthropicTokenUsage(json.usage),
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Anthropic API key is not configured.");
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      system: withStructuredOutputInstruction(input.system, input.schemaName),
      messages: [{ role: "user", content: input.user }],
    };
    const response = await fetchWithTransientRetry(`${this.baseUrl()}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    }, this.config.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS);

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "{}",
        requestBody,
        responseBody: errorText,
        errorMessage: `Anthropic request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.content?.[0]?.text ?? "{}",
      requestBody,
      responseBody: json,
      finishReason: json.stop_reason,
      tokenUsage: anthropicTokenUsage(json.usage),
    };
  }

  private baseUrl() {
    return normalizeProviderBaseUrl(this.config.baseUrl, ANTHROPIC_DEFAULT_BASE_URL, { requiredPath: "/v1" });
  }
}

function anthropicTokenUsage(usage: unknown) {
  if (!usage || typeof usage !== "object") return undefined;
  const value = usage as Record<string, unknown>;
  const inputParts = [
    optionalCount(value.input_tokens),
    optionalCount(value.cache_creation_input_tokens),
    optionalCount(value.cache_read_input_tokens),
  ];
  const input = inputParts.some((count) => count !== undefined)
    ? inputParts.reduce<number>((total, count) => total + (count ?? 0), 0)
    : undefined;
  const output = optionalCount(value.output_tokens);
  return {
    input,
    output,
    total: input !== undefined && output !== undefined ? input + output : undefined,
  };
}

function optionalCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
