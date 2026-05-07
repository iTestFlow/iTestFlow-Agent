import "server-only";

import { z } from "zod";
import type { GenerateStructuredOutputInput, LLMProvider, LLMProviderConfig, LLMProviderName, LLMResult } from "../llm-types";

export abstract class BaseJsonProvider implements LLMProvider {
  readonly name: LLMProviderName;
  readonly model: string;
  protected readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.config = config;
  }

  abstract testConnection(): Promise<boolean>;

  async generateStructuredOutput<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
  ): Promise<LLMResult<z.infer<TSchema>>> {
    const rawOutput = await this.callModel(input);
    const validatedOutput = this.parseAndValidate(input, rawOutput);

    return {
      provider: this.name,
      model: this.model,
      rawOutput,
      validatedOutput,
    };
  }

  protected abstract callModel<TSchema extends z.ZodTypeAny>(input: GenerateStructuredOutputInput<TSchema>): Promise<string>;

  private parseAndValidate<TSchema extends z.ZodTypeAny>(
    input: GenerateStructuredOutputInput<TSchema>,
    rawOutput: string,
  ): z.infer<TSchema> {
    let parsedJson: unknown;

    try {
      parsedJson = this.parseJson(rawOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown JSON parse error.";
      throw new Error(`LLM output for ${input.schemaName} was not valid JSON: ${message}`);
    }

    const result = input.schema.safeParse(parsedJson);
    if (!result.success) {
      throw new Error(`LLM output failed schema validation for ${input.schemaName}: ${result.error.message}`);
    }

    return result.data;
  }

  protected parseJson(rawOutput: string) {
    const trimmed = rawOutput.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    return JSON.parse(fenced ?? trimmed);
  }

  protected headers() {
    return {
      "Content-Type": "application/json",
    };
  }
}
