import "server-only";

import { z } from "zod";
import { BaseJsonProvider } from "./base-json-provider";
import type { GenerateStructuredOutputInput } from "../llm-types";

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

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<string> {
    if (!this.config.apiKey) throw new Error("Anthropic API key is not configured.");
    const response = await fetch(`${this.config.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
      method: "POST",
      headers: {
        ...this.headers(),
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: input.maxTokens ?? this.config.maxTokens ?? 4000,
        temperature: input.temperature ?? this.config.temperature ?? 0.2,
        system: `${input.system}\nReturn only valid JSON matching schema ${input.schemaName}.`,
        messages: [{ role: "user", content: input.user }],
      }),
    });

    if (!response.ok) throw new Error(`Anthropic request failed: ${await response.text()}`);
    const json = await response.json();
    return json.content?.[0]?.text ?? "{}";
  }
}
