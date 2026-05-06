import "server-only";

import { z } from "zod";
import { withStructuredOutputInstruction } from "../prompts";
import { BaseJsonProvider } from "./base-json-provider";
import type { GenerateStructuredOutputInput } from "../llm-types";

export class OpenAIProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    if (!this.config.apiKey || !this.config.model) return false;
    const response = await fetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/models/${this.model}`, {
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });
    return response.ok;
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<string> {
    if (!this.config.apiKey) throw new Error("OpenAI API key is not configured.");
    const response = await fetch(`${this.config.baseUrl ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.headers(),
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: input.temperature ?? this.config.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: withStructuredOutputInstruction(input.system, input.schemaName) },
          { role: "user", content: input.user },
        ],
      }),
    });

    if (!response.ok) throw new Error(`OpenAI request failed: ${await response.text()}`);
    const json = await response.json();
    return json.choices?.[0]?.message?.content ?? "{}";
  }
}
