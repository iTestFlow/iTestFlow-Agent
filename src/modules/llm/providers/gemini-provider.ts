import "server-only";

import { z } from "zod";
import { buildStructuredOutputUserPrompt } from "../prompts";
import { BaseJsonProvider } from "./base-json-provider";
import type { GenerateStructuredOutputInput } from "../llm-types";

export class GeminiProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetch(`${baseUrl}/models/${this.model}?key=${this.config.apiKey}`);
    return response.ok;
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<string> {
    if (!this.config.apiKey) throw new Error("Gemini API key is not configured.");
    const baseUrl = this.config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    const request = {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        generationConfig: {
          temperature: input.temperature ?? this.config.temperature ?? 0.2,
          maxOutputTokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
          responseMimeType: "application/json",
        },
        contents: [
          {
            role: "user",
            parts: [{ text: buildStructuredOutputUserPrompt(input) }],
          },
        ],
      }),
    };
    const response = await fetchWithTransientRetry(
      `${baseUrl}/models/${this.model}:generateContent?key=${this.config.apiKey}`,
      request,
      this.config.retryAttempts ?? 1,
    );

    if (!response.ok) throw new Error(`Gemini request failed: ${await response.text()}`);
    const json = await response.json();
    return json.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  }
}

async function fetchWithTransientRetry(url: string, init: RequestInit, retryAttempts: number) {
  let response = await fetch(url, init);
  for (let attempt = 0; attempt < retryAttempts && isTransientGeminiFailure(response); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    response = await fetch(url, init);
  }
  return response;
}

function isTransientGeminiFailure(response: Response) {
  return response.status === 429 || response.status === 503;
}
