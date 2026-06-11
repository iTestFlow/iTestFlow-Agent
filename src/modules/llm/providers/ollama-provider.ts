import "server-only";

import { z } from "zod";
import { DEFAULT_TEXT_OUTPUT_TOKENS } from "../llm-defaults";
import { buildStructuredOutputUserPrompt } from "../prompts";
import { BaseJsonProvider, type LLMProviderCallResult } from "./base-json-provider";
import type { GenerateStructuredOutputInput, GenerateTextInput } from "../llm-types";

export class OllamaProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    const response = await fetch(`${this.config.baseUrl ?? "http://localhost:11434"}/api/tags`);
    return response.ok;
  }

  protected async callTextModel(input: GenerateTextInput): Promise<LLMProviderCallResult> {
    const requestBody = {
      model: this.model,
      stream: false,
      prompt: [input.system, input.user].join("\n\n"),
    };
    const response = await fetch(`${this.config.baseUrl ?? "http://localhost:11434"}/api/generate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "",
        requestBody,
        responseBody: errorText,
        errorMessage: `Ollama request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.response ?? "",
      requestBody,
      responseBody: json,
      tokenUsage: ollamaTokenUsage(json),
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    const requestBody = {
      model: this.model,
      stream: false,
      format: "json",
      prompt: buildStructuredOutputUserPrompt(input),
      options: {
        num_predict: input.maxTokens ?? DEFAULT_TEXT_OUTPUT_TOKENS,
      },
    };
    const response = await fetch(`${this.config.baseUrl ?? "http://localhost:11434"}/api/generate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        rawOutput: "{}",
        requestBody,
        responseBody: errorText,
        errorMessage: `Ollama request failed: ${errorText}`,
      };
    }
    const json = await response.json();
    return {
      rawOutput: json.response ?? "{}",
      requestBody,
      responseBody: json,
      finishReason: json.done_reason,
      tokenUsage: ollamaTokenUsage(json),
    };
  }
}

function ollamaTokenUsage(response: unknown) {
  if (!response || typeof response !== "object") return undefined;
  const value = response as Record<string, unknown>;
  const input = optionalCount(value.prompt_eval_count);
  const output = optionalCount(value.eval_count);
  return {
    input,
    output,
    total: input !== undefined && output !== undefined ? input + output : undefined,
  };
}

function optionalCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
