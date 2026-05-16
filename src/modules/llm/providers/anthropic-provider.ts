import "server-only";

import { z } from "zod";
import { withStructuredOutputInstruction } from "../prompts";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import type { GenerateStructuredOutputInput, GenerateTextInput } from "../llm-types";

export class AnthropicProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const response = await fetch(`${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
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
      max_tokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
      temperature: input.temperature ?? this.config.temperature ?? 0.2,
      system: input.system,
      messages: [{ role: "user", content: input.user }],
    };
    const response = await fetch(`${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

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
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    if (!this.config.apiKey) throw new Error("Anthropic API key is not configured.");
    const requestBody = {
      model: this.model,
      max_tokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
      temperature: input.temperature ?? this.config.temperature ?? 0.2,
      system: withStructuredOutputInstruction(input.system, input.schemaName),
      messages: [{ role: "user", content: input.user }],
    };
    const response = await fetch(`${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestBody),
    });

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
    };
  }
}
