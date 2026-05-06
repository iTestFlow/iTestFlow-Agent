import "server-only";

import { z } from "zod";
import { buildStructuredOutputUserPrompt } from "../prompts";
import { BaseJsonProvider } from "./base-json-provider";
import type { GenerateStructuredOutputInput } from "../llm-types";

export class OllamaProvider extends BaseJsonProvider {
  async testConnection(): Promise<boolean> {
    const response = await fetch(`${this.config.baseUrl ?? "http://localhost:11434"}/api/tags`);
    return response.ok;
  }

  protected async callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<string> {
    const response = await fetch(`${this.config.baseUrl ?? "http://localhost:11434"}/api/generate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        prompt: buildStructuredOutputUserPrompt(input),
        options: {
          temperature: input.temperature ?? this.config.temperature ?? 0.2,
        },
      }),
    });

    if (!response.ok) throw new Error(`Ollama request failed: ${await response.text()}`);
    const json = await response.json();
    return json.response ?? "{}";
  }
}
