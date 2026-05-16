import "server-only";

import { z } from "zod";
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
      options: {
        temperature: input.temperature ?? this.config.temperature ?? 0.2,
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
    };
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<LLMProviderCallResult> {
    const requestBody = {
      model: this.model,
      stream: false,
      format: "json",
      prompt: buildStructuredOutputUserPrompt(input),
      options: {
        temperature: input.temperature ?? this.config.temperature ?? 0.2,
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
    };
  }
}
